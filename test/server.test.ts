import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventStore } from "../src/event-store.ts";
import { startServer } from "../src/server.ts";
import { TELEMETRY_VERSION, type TelemetryEvent } from "../shared/protocol.ts";

function event(seq: number): TelemetryEvent {
  return {
    version: TELEMETRY_VERSION,
    producerId: "pi-persona",
    producerVersion: "1.10.5",
    id: `s:${seq}`,
    seq,
    ts: seq,
    sessionId: "s",
    workspaceId: "0123456789abcdef01234567",
    type: "instance.heartbeat",
    payload: { contextPercent: seq },
  };
}

async function withServer(fn: (url: string, token: string, store: EventStore) => Promise<void>): Promise<void> {
  const store = new EventStore();
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>flow</title>");
  const server = await startServer({ port: 0, store, staticDir });
  try { await fn(`http://127.0.0.1:${server.port}`, server.token, store); }
  finally { await server.close(); }
}

test("API requires the per-server token and exposes security headers without CORS", async () => {
  await withServer(async (url, token) => {
    const denied = await fetch(`${url}/api/snapshot`);
    assert.equal(denied.status, 401);
    const response = await fetch(`${url}/api/snapshot?token=${token}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src/);
    assert.equal((await response.json() as { cursor: number }).cursor, 0);
  });
});

test("the generated dashboard token is a four-character Base62 code", async () => {
  await withServer(async (_url, token) => {
    assert.match(token, /^[0-9A-Za-z]{4}$/);
  });
});

test("only a valid landing token may mint the dashboard cookie", async () => {
  await withServer(async (url, token) => {
    const denied = await fetch(`${url}/?token=wrong`);
    assert.equal(denied.status, 200, "the static shell remains public");
    assert.equal(denied.headers.get("set-cookie"), null, "an invalid query must not disclose the real token");

    const accepted = await fetch(`${url}/?token=${token}`);
    const setCookie = accepted.headers.get("set-cookie") ?? "";
    // Port-scoped by name, because a cookie is scoped by HOST and never by port (RFC 6265 s8.5): a
    // shared name puts every `http://127.0.0.1:*` dashboard in one slot, and a second Pi session lands
    // on a second port whenever the default one is taken.
    assert.match(setCookie, new RegExp(`^flow_token_${new URL(url).port}=${token};`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);

    const cookie = setCookie.split(";", 1)[0]!;
    const authenticated = await fetch(`${url}/api/snapshot`, { headers: { Cookie: cookie } });
    assert.equal(authenticated.status, 200);
  });
});

test("no ambient credential can veto the token the dashboard URL carries", async () => {
  await withServer(async (url, token) => {
    const port = new URL(url).port;
    const name = `flow_token_${port}`;
    // A wrong cookie used to OUTRANK the query, so the last dashboard opened silently 401'd every
    // other one; a sibling loopback page could plant the same denial on purpose with a `Path=/api`
    // copy, which sorts first and so won a first-match parse.
    const clobbered = await fetch(`${url}/api/snapshot?token=${token}`, { headers: { Cookie: `${name}=WRNG` } });
    assert.equal(clobbered.status, 200, "the token in the URL must stand on its own");

    const planted = await fetch(`${url}/api/snapshot?token=${token}`, { headers: { Cookie: `${name}=evil; ${name}=${token}` } });
    assert.equal(planted.status, 200, "a planted duplicate must not shadow the real cookie");

    // An empty header is a string, and short-circuiting on its type suppressed both fallbacks.
    const emptyHeader = await fetch(`${url}/api/snapshot?token=${token}`, { headers: { "X-Flow-Token": "" } });
    assert.equal(emptyHeader.status, 200, "an empty credential is absent, not a rejection");

    const nothing = await fetch(`${url}/api/snapshot`, { headers: { Cookie: `${name}=WRNG` } });
    assert.equal(nothing.status, 401, "a wrong credential still authorizes nothing on its own");
  });
});

test("a stream that dies mid-frame is dropped, not raised at the host", async () => {
  const store = new EventStore();
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-disarm-"));
  writeFileSync(join(staticDir, "index.html"), "ok");
  const server = await startServer({ port: 0, store, staticDir, heartbeatMs: 5 });
  const socket = connect(server.port, "127.0.0.1");
  await new Promise((done) => socket.once("connect", done));
  const crlf = String.fromCharCode(13, 10);
  socket.write(`GET /api/stream?token=${server.token} HTTP/1.1${crlf}Host: 127.0.0.1${crlf}${crlf}`);
  socket.pause();
  for (let waited = 0; server.clientCount() === 0 && waited < 2_000; waited += 20) await new Promise((done) => setTimeout(done, 20));
  assert.equal(server.clientCount(), 1);

  const failures: unknown[] = [];
  const record = (error: unknown): void => { failures.push(error); };
  process.on("uncaughtException", record);
  try {
    // A reset connection, which is what a browser tab closed mid-frame looks like. The host here is
    // the user's long-lived agent, not a disposable web server, so a write failure has to end the
    // connection and nothing else. Node's http server currently destroys the response on a socket
    // error by itself, so this passes with or without the explicit `error` listener in openStream —
    // it pins the OUTCOME, and the listener is there so the outcome does not depend on that.
    const filler = "d".repeat(900);
    socket.resetAndDestroy();
    for (let seq = 1; seq <= 4_000; seq += 1) store.append({ ...event(seq), payload: { contextPercent: seq % 100, displayName: filler } });
    await new Promise((done) => setTimeout(done, 80));
    assert.deepEqual(failures.map((error) => (error as Error).message), []);
    assert.equal(server.clientCount(), 0, "the dead stream is forgotten");
  } finally {
    process.off("uncaughtException", record);
    socket.destroy();
    await server.close();
  }
});

test("a stream that stops reading is dropped instead of buffered without bound", async () => {
  const store = new EventStore();
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-backpressure-"));
  writeFileSync(join(staticDir, "index.html"), "ok");
  const server = await startServer({ port: 0, store, staticDir, maxStreamBufferBytes: 1 });
  try {
    // A socket that never reads: the frames pile up in the host process, which is the user's agent
    // session and not a disposable web server. A backgrounded browser tab is the ordinary way there.
    const socket = connect(server.port, "127.0.0.1");
    await new Promise((done) => socket.once("connect", done));
    const crlf = String.fromCharCode(13, 10);
    socket.write(`GET /api/stream?token=${server.token} HTTP/1.1${crlf}Host: 127.0.0.1${crlf}${crlf}`);
    socket.pause();
    for (let waited = 0; server.clientCount() === 0 && waited < 2_000; waited += 20) await new Promise((done) => setTimeout(done, 20));
    assert.equal(server.clientCount(), 1);
    for (let seq = 1; seq <= 400 && server.clientCount() > 0; seq += 1) store.append(event(seq));
    assert.equal(server.clientCount(), 0, "the stalled client is dropped, not buffered");
    socket.destroy();
  } finally {
    await server.close();
  }
});

test("concurrent streams are capped instead of unbounded", async () => {
  const store = new EventStore();
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-cap-"));
  writeFileSync(join(staticDir, "index.html"), "ok");
  const server = await startServer({ port: 0, store, staticDir, maxStreamClients: 2 });
  const open: Response[] = [];
  try {
    for (let index = 0; index < 2; index += 1) open.push(await fetch(`http://127.0.0.1:${server.port}/api/stream?token=${server.token}`));
    assert.equal(server.clientCount(), 2);
    const refused = await fetch(`http://127.0.0.1:${server.port}/api/stream?token=${server.token}`);
    assert.equal(refused.status, 503);
    await refused.body?.cancel();
  } finally {
    for (const response of open) await response.body?.cancel().catch(() => undefined);
    await server.close();
  }
});

test("stream replays deltas after Last-Event-ID and after query cursor", async () => {
  await withServer(async (url, token, store) => {
    store.append(event(1));
    store.append(event(2));
    const response = await fetch(`${url}/api/stream`, {
      headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": "1" },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done || text.includes("id: 2")) break;
    }
    assert.match(text, /id: 2/);
    assert.match(text, /s:2/);
    await reader.cancel();

    const afterResponse = await fetch(`${url}/api/stream?token=${token}&after=1`);
    assert.equal(afterResponse.status, 200);
    const afterReader = afterResponse.body!.getReader();
    const afterDecoder = new TextDecoder();
    let afterText = "";
    while (!afterText.includes("id: 2")) {
      const chunk = await afterReader.read();
      afterText += afterDecoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) break;
    }
    assert.match(afterText, /id: 2/);
    await afterReader.cancel();
  });
});

test("stream emits bounded heartbeat comments", async () => {
  const store = new EventStore();
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-heartbeat-"));
  writeFileSync(join(staticDir, "index.html"), "ok");
  const server = await startServer({ port: 0, store, staticDir, heartbeatMs: 10 });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/stream?token=${server.token}`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 500;
    while (!text.includes(": heartbeat") && Date.now() < deadline) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) break;
    }
    assert.match(text, /: heartbeat/);
    await reader.cancel();
  } finally {
    await server.close();
  }
});

test("shutdown is idempotent and drops an active stream", async () => {
  const store = new EventStore();
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-close-"));
  writeFileSync(join(staticDir, "index.html"), "ok");
  const server = await startServer({ port: 0, store, staticDir });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/stream?token=${server.token}`);
  assert.equal(server.clientCount(), 1);
  await Promise.all([server.close(), server.close()]);
  assert.equal(server.clientCount(), 0);
  await response.body?.cancel();
});

/** Issue a request target the WHATWG URL parser rejects; fetch() would normalise it away. */
function rawRequest(port: number, target: string, host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.setEncoding("utf8");
    let text = "";
    socket.setTimeout(2_000, () => socket.destroy(new Error("no response")));
    socket.on("data", (chunk: string) => { text += chunk; });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

test("a non-loopback Host cannot use the short launch token", async () => {
  await withServer(async (url, token) => {
    const port = Number(new URL(url).port);
    const denied = await rawRequest(port, `/api/snapshot?token=${token}`, "rebound.example");
    assert.match(denied, /^HTTP\/1\.1 400 /);
    const survived = await fetch(`${url}/api/snapshot?token=${token}`);
    assert.equal(survived.status, 200);
  });
});

test("a same-length non-ASCII token is refused without throwing out of the request listener", async () => {
  await withServer(async (url, token) => {
    const candidate = "é".repeat(token.length);
    assert.equal(candidate.length, token.length, "the probe must clear the code-unit guard");
    assert.notEqual(Buffer.byteLength(candidate), Buffer.byteLength(token), "the probe must differ in bytes");
    const denied = await fetch(`${url}/api/snapshot?token=${encodeURIComponent(candidate)}`);
    assert.equal(denied.status, 401);
    const survived = await fetch(`${url}/api/snapshot?token=${token}`);
    assert.equal(survived.status, 200);
  });
});

test("an unparseable request target is answered instead of killing the host process", async () => {
  await withServer(async (url, token) => {
    const port = Number(new URL(url).port);
    const response = await rawRequest(port, "//");
    // Pin 400: a later change that lets "//" fall through to serveStatic would answer 404.
    assert.match(response, /^HTTP\/1\.1 400 /);
    const survived = await fetch(`${url}/api/snapshot?token=${token}`);
    assert.equal(survived.status, 200);
  });
});

/**
 * A producer killed without an instance.stopped goes silent, and the store ages its stream out. A
 * client that is already connected folds deltas and has no clock of its own, so unless the ageing
 * out is delivered it keeps drawing the dead producer as live.
 */
test("a stream that ages out reaches an already-connected stream client", async () => {
  let now = 1_700_000_000_000;
  const store = new EventStore({ staleAfterMs: 100, now: () => now });
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-stale-"));
  writeFileSync(join(staticDir, "index.html"), "ok");
  const server = await startServer({ port: 0, store, staticDir, heartbeatMs: 20 });
  const started = { ...event(1), ts: now, type: "instance.started", payload: { displayName: "s", status: "active", pid: 1, contextPercent: 0, exocomEnabled: false } } as TelemetryEvent;
  assert.equal(store.append(started), 1);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/stream?token=${server.token}`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const readUntil = async (match: RegExp, complaint: string): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!match.test(text) && Date.now() < deadline) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) break;
    }
    assert.match(text, match, `${complaint} — stream carried: ${JSON.stringify(text.slice(0, 600))}`);
  };
  try {
    await readUntil(/"status":"active"/, "the connecting client never got its opening frame");
    now += 1_000; // the producer dies: no instance.stopped, just silence past the stale window
    await readUntil(/"status":"stale"/, "the stale transition never reached the connected client");
    assert.ok(!text.includes("~flow"), "a consumer-minted notice must never reach a client as a producer event");

    // The stale notice must not have consumed the producer's next sequence number.
    assert.equal(store.append({ ...event(2), ts: now }), 3);
    await readUntil(/s:2/, "the producer's next event was swallowed after the stale notice");
    assert.equal(store.snapshot().state.lastSeq["pi-persona::s"], 2);
  } finally {
    await reader.cancel();
    await server.close();
  }
});

/**
 * A reader that keeps everything it has read. Counting frames means counting them across the whole
 * connection, opening frame included, so the accumulator has to outlive one wait.
 */
function streamReader(response: Response): { until(match: RegExp, complaint: string): Promise<string>; cancel(): Promise<void> } {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    async until(match: RegExp, complaint: string): Promise<string> {
      const deadline = Date.now() + 5_000;
      while (!match.test(text) && Date.now() < deadline) {
        const chunk = await reader.read();
        text += decoder.decode(chunk.value, { stream: !chunk.done });
        if (chunk.done) break;
      }
      assert.match(text, match, `${complaint} — stream carried: ${JSON.stringify(text.slice(0, 400))}`);
      return text;
    },
    cancel: () => reader.cancel(),
  };
}

function startedEvent(session: string, ts: number): TelemetryEvent {
  return {
    ...event(1),
    id: `${session}:1`,
    sessionId: session,
    ts,
    type: "instance.started",
    payload: { displayName: session, status: "active", pid: 1, contextPercent: 0, exocomEnabled: false },
  } as TelemetryEvent;
}

/**
 * One sweep relabels every silent stream at once, and each notice it mints yields the identical graph.
 * A frame per stream is that graph pushed once per stream down every connection — measured at 45 MB and
 * a 423 ms stall for 60 streams holding a 750 KB graph — so a sweep is worth exactly one frame.
 */
test("a sweep that ages out many streams costs a connected client one snapshot frame", async () => {
  let now = 1_700_000_000_000;
  const store = new EventStore({ staleAfterMs: 100, now: () => now });
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-sweep-"));
  writeFileSync(join(staticDir, "index.html"), "ok");
  // The sweep is driven by hand: an interval firing a second one mid-assertion would forge the count.
  const server = await startServer({ port: 0, store, staticDir, heartbeatMs: 60_000, staleSweepMs: 60_000 });
  for (let index = 0; index < 40; index += 1) store.append(startedEvent(`aged-${index}`, now));
  const response = await fetch(`http://127.0.0.1:${server.port}/api/stream?token=${server.token}`);
  const reader = streamReader(response);
  try {
    await reader.until(/event: snapshot/, "the connecting client never got its opening frame");
    now += 10_000; // every producer dies at once: no instance.stopped, just silence
    assert.equal(store.sweepStale(), 40);
    // A real delta behind the sweep's frames: the stream is ordered, so reaching it proves the sweep
    // finished writing.
    store.append(startedEvent("fence", now));
    const text = await reader.until(/fence:1/, "the sweep never converged the client");
    assert.match(text, /"status":"stale"/, "the client must still learn that streams aged out");
    assert.equal(text.split("event: snapshot").length - 1, 2, "one opening frame plus one for the sweep");

    // The cursor a frame was deduped against must not swallow the NEXT sweep: the fence stream falls
    // silent in its turn and is worth a frame of its own.
    now += 10_000;
    assert.equal(store.sweepStale(), 1);
    const later = await reader.until(/"fence"[^}]*"status":"stale"/, "a later sweep never reached the client");
    assert.equal(later.split("event: snapshot").length - 1, 3, "each sweep that finds new silence is worth one frame");
  } finally {
    await reader.cancel();
    await server.close();
  }
});

/**
 * `sendSnapshot` drops a frame whose cursor a client already holds, but an argument is evaluated before
 * the call: materialising the snapshot eagerly pays for the whole-graph clone the guard exists to avoid.
 */
test("a replayed backlog clones the graph only for the frame it actually sends", async () => {
  let now = 1_700_000_000_000;
  const store = new EventStore({ staleAfterMs: 100, now: () => now });
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-replay-"));
  writeFileSync(join(staticDir, "index.html"), "ok");
  // Six sweeps, so the replay window holds six notices however well one sweep coalesces.
  for (let index = 0; index < 6; index += 1) {
    store.append(startedEvent(`aged-${index}`, now));
    now += 10_000;
    assert.equal(store.sweepStale(), 1);
  }
  let clones = 0;
  const snapshot = store.snapshot.bind(store);
  store.snapshot = () => { clones += 1; return snapshot(); };
  const server = await startServer({ port: 0, store, staticDir, heartbeatMs: 60_000, staleSweepMs: 60_000 });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/stream?token=${server.token}&after=0`);
  const reader = streamReader(response);
  try {
    await reader.until(/event: snapshot/, "a replayed notice must still converge the client");
    // A real delta behind the replay: reaching it proves every backlog frame is already on the wire.
    store.append(startedEvent("fence", now));
    const text = await reader.until(/fence:1/, "the replay never reached the live tail");
    assert.equal(text.split("event: snapshot").length - 1, 1, "the notices behind the first carry the same cursor");
    assert.equal(clones, 1, "a notice whose snapshot the client already holds must not clone the graph");
  } finally {
    await reader.cancel();
    await server.close();
  }
});

/** An interval outliving the server would sweep a store the host has finished with. */
test("closing the server stops the stale sweep", async () => {
  const store = new EventStore();
  let sweeps = 0;
  const sweepStale = store.sweepStale.bind(store);
  store.sweepStale = () => { sweeps += 1; return sweepStale(); };
  const staticDir = mkdtempSync(join(tmpdir(), "flow-web-sweep-close-"));
  writeFileSync(join(staticDir, "index.html"), "ok");
  const server = await startServer({ port: 0, store, staticDir, staleSweepMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(sweeps > 0, "the server must sweep while it is up");
  await server.close();
  const afterClose = sweeps;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sweeps, afterClose, "the sweep interval outlived the server");
});
