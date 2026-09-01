import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isConsumerNotice, type TelemetryDelta, type EventStore, type TelemetrySnapshot } from "./event-store.ts";

export interface FlowServerOptions {
  port: number;
  store: EventStore;
  staticDir?: string;
  token?: string;
  /** Override the keep-alive interval for deterministic tests; defaults to 15s. */
  heartbeatMs?: number;
  /** Override how often silent streams are aged out; defaults to the keep-alive interval. */
  staleSweepMs?: number;
}

export interface FlowServer {
  port: number;
  url: string;
  token: string;
  broadcast(): void;
  clientCount(): number;
  close(): Promise<void>;
}

type SnapshotSource = Pick<EventStore, "snapshot" | "backlog" | "subscribe" | "sweepStale" | "cursor">;

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_DIRS = [
  path.resolve(sourceDir, "web"),
  path.resolve(sourceDir, "../dist/web"),
  path.resolve(process.cwd(), "dist/web"),
];

/** Start the authenticated loopback dashboard server. */
export function startServer(options: FlowServerOptions): Promise<FlowServer>;
/** Compatibility overload for callers that only provide a snapshot source. */
export function startServer(port: number, getSnapshot: () => TelemetrySnapshot): Promise<FlowServer>;
export function startServer(
  optionsOrPort: FlowServerOptions | number,
  oldGetSnapshot?: () => TelemetrySnapshot,
): Promise<FlowServer> {
  const legacySource: SnapshotSource | undefined = typeof optionsOrPort === "number"
    ? {
        snapshot: oldGetSnapshot as () => TelemetrySnapshot,
        backlog: () => undefined,
        subscribe: () => () => undefined,
        sweepStale: () => 0,
        // A legacy caller hands over a snapshot function and nothing else; it never subscribes, so the
        // one frame it sends is always the first and no cursor of its own has to precede it.
        cursor: 0,
      }
    : undefined;
  const options: FlowServerOptions = typeof optionsOrPort === "number"
    ? { port: optionsOrPort, store: legacySource as EventStore }
    : optionsOrPort;
  const source = (legacySource ?? options.store) as unknown as SnapshotSource;
  const staticDir = options.staticDir ?? DEFAULT_STATIC_DIRS.find((dir) => fs.existsSync(dir)) ?? DEFAULT_STATIC_DIRS[0]!;
  const token = options.token ?? crypto.randomBytes(32).toString("hex");
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const staleSweepMs = options.staleSweepMs ?? heartbeatMs;
  if (token.length === 0 || token.length > 256) throw new Error("token must be a non-empty value");
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) throw new RangeError("heartbeatMs must be positive");
  if (!Number.isFinite(staleSweepMs) || staleSweepMs < 1) throw new RangeError("staleSweepMs must be positive");

  const clients = new Map<http.ServerResponse, () => void>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const server = http.createServer((req, res) => {
    applySecurityHeaders(res);
    // A throw here escapes into the host process as an uncaught exception, so no
    // attacker-supplied request target may reach the parser unguarded.
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      return send(res, 400, "Bad Request", "text/plain; charset=utf-8");
    }
    const pathname = requestUrl.pathname;

    if (pathname.startsWith("/api/")) {
      if (req.method !== "GET") return send(res, 405, "Method Not Allowed", "text/plain; charset=utf-8");
      if (!authorized(req, requestUrl, token)) return unauthorized(res);
      if (pathname === "/api/snapshot") {
        return sendJson(res, source.snapshot());
      }
      if (pathname === "/api/stream") {
        return openStream(req, res, source, clients, requestUrl, heartbeatMs);
      }
      return send(res, 404, "Not Found", "text/plain; charset=utf-8");
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed", "text/plain; charset=utf-8");
    if (pathname === "/health") return sendJson(res, { ok: !closed, clients: clients.size });
    return serveStatic(res, staticDir, pathname, requestUrl.searchParams.has("token") ? token : undefined, req.method === "HEAD");
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      const baseUrl = `http://127.0.0.1:${port}`;
      // Ageing a stream out is a wall-clock event with no producer to trigger it, so the dashboard
      // has to drive it on its own tick or a crashed producer never leaves a connected client's
      // screen. Unref'd so the host process can still exit while a session is idle.
      const sweep = setInterval(() => { if (!closed) source.sweepStale(); }, staleSweepMs);
      sweep.unref?.();
      const flow: FlowServer = {
        port,
        token,
        url: `${baseUrl}/?token=${token}`,
        broadcast() {
          // Store subscriptions push deltas directly; this method is retained as
          // a small lifecycle-safe compatibility hook.
        },
        clientCount: () => clients.size,
        close: () => {
          if (closePromise) return closePromise;
          closed = true;
          clearInterval(sweep);
          for (const [client, unsubscribe] of clients) {
            unsubscribe();
            client.end();
          }
          clients.clear();
          closePromise = new Promise<void>((done) => {
            server.close(() => done());
          });
          return closePromise;
        },
      };
      resolve(flow);
    });
  });
}

function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
}

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  const bearer = req.headers.authorization;
  const supplied = bearer?.startsWith("Bearer ") ? bearer.slice(7) : req.headers["x-flow-token"];
  const cookie = req.headers.cookie?.match(/(?:^|;\s*)flow_token=([^;]+)/)?.[1];
  const query = url.searchParams.get("token");
  const candidate = typeof supplied === "string" ? supplied : cookie ?? query;
  if (typeof candidate !== "string") return false;
  // timingSafeEqual compares BYTES and throws on a length mismatch; a code-unit
  // guard lets a non-ASCII candidate through and takes the host process down.
  const offered = Buffer.from(candidate, "utf8");
  const expected = Buffer.from(token, "utf8");
  return offered.length === expected.length && crypto.timingSafeEqual(offered, expected);
}

function unauthorized(res: http.ServerResponse): void {
  res.setHeader("WWW-Authenticate", "Bearer");
  send(res, 401, "Unauthorized", "text/plain; charset=utf-8");
}

function sendJson(res: http.ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function send(res: http.ServerResponse, status: number, body: string, type: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(body);
}

function openStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  source: SnapshotSource,
  clients: Map<http.ServerResponse, () => void>,
  url: URL,
  heartbeatMs: number,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  let active = true;
  const heartbeat = setInterval(() => {
    if (!active || res.destroyed) return;
    res.write(": heartbeat\n\n");
  }, heartbeatMs);
  heartbeat.unref?.();
  let lastSnapshotCursor = -1;
  /**
   * `snapshot` is the view a subscriber already holds; without one the source is asked for its own.
   * Both cost a deep clone of the whole graph — the subscriber's behind a getter `JSON.stringify`
   * trips — so the cursor decides whether this frame is worth sending BEFORE anything is cloned.
   */
  const sendSnapshot = (snapshot?: TelemetrySnapshot): void => {
    if (!active || res.destroyed || (snapshot?.cursor ?? source.cursor) === lastSnapshotCursor) return;
    const frame = snapshot ?? source.snapshot();
    lastSnapshotCursor = frame.cursor;
    res.write(`id: ${frame.cursor}\nevent: snapshot\ndata: ${JSON.stringify(frame)}\n\n`);
  };
  const sendDelta = (delta: TelemetryDelta, snapshot?: TelemetrySnapshot): void => {
    if (!active || res.destroyed) return;
    // A stale notice is minted by this consumer, not signed by a producer, so it is never handed
    // over as a telemetry delta. It ships as the authoritative snapshot instead — exactly what
    // /api/snapshot would answer — so a stream client converges instead of diverging from it.
    if (isConsumerNotice(delta.event)) return sendSnapshot(snapshot);
    res.write(`id: ${delta.cursor}\nevent: telemetry\ndata: ${JSON.stringify(delta)}\n\n`);
  };
  const unsubscribe = source.subscribe((delta, snapshot) => sendDelta(delta, snapshot));
  clients.set(res, unsubscribe);
  const lastHeader = req.headers["last-event-id"];
  const rawCursor = (typeof lastHeader === "string" ? lastHeader : url.searchParams.get("after") ?? url.searchParams.get("lastEventId")) ?? "";
  const cursor = /^\d+$/.test(rawCursor) ? Number(rawCursor) : undefined;
  const backlog = cursor === undefined ? undefined : source.backlog(cursor);
  if (cursor !== undefined && backlog !== undefined) {
    for (const delta of backlog) sendDelta(delta);
  } else {
    sendSnapshot();
  }

  const cleanup = (): void => {
    if (!active) return;
    active = false;
    clearInterval(heartbeat);
    unsubscribe();
    clients.delete(res);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

function serveStatic(
  res: http.ServerResponse,
  root: string,
  pathname: string,
  token: string | undefined,
  headOnly: boolean,
): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, "Bad Request", "text/plain; charset=utf-8");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const rootResolved = path.resolve(root);
  const file = path.resolve(rootResolved, relative);
  if (file !== rootResolved && !file.startsWith(`${rootResolved}${path.sep}`)) return send(res, 404, "Not Found", "text/plain; charset=utf-8");
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    return send(res, 404, "Not Found", "text/plain; charset=utf-8");
  }
  if (token) res.setHeader("Set-Cookie", `flow_token=${token}; HttpOnly; SameSite=Strict; Path=/`);
  res.statusCode = 200;
  res.setHeader("Content-Type", mimeType(file));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", body.length);
  if (!headOnly) res.end(body);
  else res.end();
}

function mimeType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}
