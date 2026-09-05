import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isConsumerNotice, type TelemetryDelta, type EventStore, type TelemetrySnapshot } from "./event-store.ts";

export const DASHBOARD_TOKEN_LENGTH = 4;
export const DASHBOARD_TOKEN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A stalled SSE client's frames queue in the host Pi process, which is the user's agent session and
 * not a disposable web server. Past this much unflushed output the connection is dropped: EventSource
 * reconnects on its own and re-syncs from a fresh snapshot, which is strictly better than growing the
 * agent's heap for a tab that stopped reading.
 */
export const MAX_STREAM_BUFFER_BYTES = 4 * 1024 * 1024;
/** Concurrent /api/stream clients. A dashboard holds one; the ceiling only bounds a runaway. */
export const MAX_STREAM_CLIENTS = 32;
/** Cookie headers are attacker-influenced (any sibling loopback origin can add a `Path=/api` copy). */
const MAX_COOKIE_CANDIDATES = 8;

/** Short, human-readable launch code. This is a loopback convenience gate, not strong authentication. */
export function createDashboardToken(): string {
  return Array.from(
    { length: DASHBOARD_TOKEN_LENGTH },
    () => DASHBOARD_TOKEN_ALPHABET[crypto.randomInt(DASHBOARD_TOKEN_ALPHABET.length)]!,
  ).join("");
}

export interface FlowServerOptions {
  port: number;
  store: EventStore;
  staticDir?: string;
  token?: string;
  /** Override the keep-alive interval for deterministic tests; defaults to 15s. */
  heartbeatMs?: number;
  /** Override how often silent streams are aged out; defaults to the keep-alive interval. */
  staleSweepMs?: number;
  /** Override the unflushed-output ceiling that drops a stalled stream; defaults to 4 MiB. */
  maxStreamBufferBytes?: number;
  /** Override the concurrent /api/stream ceiling; defaults to 32. */
  maxStreamClients?: number;
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
  const token = options.token ?? createDashboardToken();
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const staleSweepMs = options.staleSweepMs ?? heartbeatMs;
  const maxStreamBufferBytes = options.maxStreamBufferBytes ?? MAX_STREAM_BUFFER_BYTES;
  const maxStreamClients = options.maxStreamClients ?? MAX_STREAM_CLIENTS;
  if (token.length === 0 || token.length > 256) throw new Error("token must be a non-empty value");
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) throw new RangeError("heartbeatMs must be positive");
  if (!Number.isFinite(staleSweepMs) || staleSweepMs < 1) throw new RangeError("staleSweepMs must be positive");
  if (!Number.isFinite(maxStreamBufferBytes) || maxStreamBufferBytes < 1) throw new RangeError("maxStreamBufferBytes must be positive");
  if (!Number.isSafeInteger(maxStreamClients) || maxStreamClients < 1) throw new RangeError("maxStreamClients must be positive");

  const clients = new Map<http.ServerResponse, () => void>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  // Named per port at listen time. A cookie cannot be port-scoped over http, so a shared name would
  // put every loopback dashboard in one slot; the name is the only part of the tuple we control.
  let cookieName = "flow_token";

  const server = http.createServer((req, res) => {
    applySecurityHeaders(res);
    // The four-character code is only a loopback convenience gate. Reject arbitrary Host values
    // so a DNS-rebinding origin cannot turn the browser into a same-origin token oracle.
    if (!isLoopbackHost(req.headers.host)) return send(res, 400, "Bad Request", "text/plain; charset=utf-8");
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
      if (!authorized(req, requestUrl, token, cookieName)) return unauthorized(res);
      if (pathname === "/api/snapshot") {
        return sendJson(res, source.snapshot());
      }
      if (pathname === "/api/stream") {
        if (clients.size >= maxStreamClients) return send(res, 503, "Too Many Streams", "text/plain; charset=utf-8");
        return openStream(req, res, source, clients, requestUrl, heartbeatMs, maxStreamBufferBytes);
      }
      return send(res, 404, "Not Found", "text/plain; charset=utf-8");
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed", "text/plain; charset=utf-8");
    if (pathname === "/health") return sendJson(res, { ok: !closed, clients: clients.size });
    const landingToken = requestUrl.searchParams.get("token");
    return serveStatic(res, staticDir, pathname, matchesToken(landingToken, token) ? token : undefined, req.method === "HEAD", cookieName);
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      const baseUrl = `http://127.0.0.1:${port}`;
      cookieName = `flow_token_${port}`;
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
          // Each client's OWN teardown, not half of it. Ending the response without disarming its
          // heartbeat left the interval armed against a finished stream, and the next tick's write
          // raised ERR_STREAM_WRITE_AFTER_END on a response with no `error` listener — an uncaught
          // exception that took the host Pi session down with the dashboard.
          for (const [client, cleanup] of [...clients]) {
            cleanup();
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

function isLoopbackHost(host: string | undefined): boolean {
  return typeof host === "string" && /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(host);
}

function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
}

/**
 * Any presented credential may authorize the request; none of them may veto the others.
 *
 * Ranking them was the bug. A cookie is scoped by HOST and never by port (RFC 6265 §8.5), so every
 * `http://127.0.0.1:*` origin shares one `flow_token` slot — and a second Pi session lands on a second
 * port whenever 7874 is taken. With the cookie outranking the URL, the last dashboard opened silently
 * 401'd every other one even though each tab carried its own correct token in its own query string. A
 * sibling loopback page could do the same on purpose by planting a longer-path copy, which sorts first
 * (§5.4) and so won a first-match parse. An empty `X-Flow-Token:` header could likewise veto a valid
 * `?token=`. Checking every candidate makes a wrong or planted one merely irrelevant.
 */
function authorized(req: http.IncomingMessage, url: URL, token: string, cookieName: string): boolean {
  const bearer = req.headers.authorization;
  const header = bearer?.startsWith("Bearer ") ? bearer.slice(7) : req.headers["x-flow-token"];
  if (matchesToken(url.searchParams.get("token"), token)) return true;
  if (matchesToken(header, token)) return true;
  return cookieValues(req.headers.cookie, cookieName).some((value) => matchesToken(value, token));
}

/** Every `<name>=` in a Cookie header, not just the first one a regex happens to reach. */
function cookieValues(header: string | undefined, name: string): string[] {
  if (typeof header !== "string") return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    values.push(part.slice(eq + 1).trim());
    if (values.length >= MAX_COOKIE_CANDIDATES) break;
  }
  return values;
}

function matchesToken(candidate: unknown, token: string): boolean {
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
  maxBufferBytes: number,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  let active = true;
  let unsubscribe: () => void = () => undefined;
  const cleanup = (): void => {
    if (!active) return;
    active = false;
    clearInterval(heartbeat);
    unsubscribe();
    clients.delete(res);
  };
  /**
   * Every frame goes through here so no write can outrun the client reading it. `res.write` returning
   * false means the kernel buffer is full and Node is queueing in userspace — that queue is the host
   * agent's heap, and a backgrounded tab holding an EventSource is the ordinary way to fill it. Past
   * the ceiling the connection is dropped rather than buffered; EventSource reconnects and re-syncs.
   */
  const write = (frame: string): void => {
    if (!active || res.destroyed) return;
    if (!res.write(frame) && res.writableLength > maxBufferBytes) {
      cleanup();
      res.destroy();
    }
  };
  const heartbeat = setInterval(() => write(": heartbeat\n\n"), heartbeatMs);
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
    write(`id: ${frame.cursor}\nevent: snapshot\ndata: ${JSON.stringify(frame)}\n\n`);
  };
  const sendDelta = (delta: TelemetryDelta, snapshot?: TelemetrySnapshot): void => {
    if (!active || res.destroyed) return;
    // A stale notice is minted by this consumer, not signed by a producer, so it is never handed
    // over as a telemetry delta. It ships as the authoritative snapshot instead — exactly what
    // /api/snapshot would answer — so a stream client converges instead of diverging from it.
    if (isConsumerNotice(delta.event)) return sendSnapshot(snapshot);
    write(`id: ${delta.cursor}\nevent: telemetry\ndata: ${JSON.stringify(delta)}\n\n`);
  };
  unsubscribe = source.subscribe((delta, snapshot) => sendDelta(delta, snapshot));
  clients.set(res, cleanup);
  const lastHeader = req.headers["last-event-id"];
  const rawCursor = (typeof lastHeader === "string" ? lastHeader : url.searchParams.get("after") ?? url.searchParams.get("lastEventId")) ?? "";
  const cursor = /^\d+$/.test(rawCursor) ? Number(rawCursor) : undefined;
  const backlog = cursor === undefined ? undefined : source.backlog(cursor);
  if (cursor !== undefined && backlog !== undefined) {
    for (const delta of backlog) sendDelta(delta);
  } else {
    sendSnapshot();
  }

  req.on("close", cleanup);
  res.on("close", cleanup);
  // Without a listener Node re-emits a stream write failure as an uncaught exception, so a client
  // that dies mid-frame would end the user's agent session rather than its own connection.
  res.on("error", cleanup);
}

function serveStatic(
  res: http.ServerResponse,
  root: string,
  pathname: string,
  token: string | undefined,
  headOnly: boolean,
  cookieName: string,
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
  if (token) res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
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
