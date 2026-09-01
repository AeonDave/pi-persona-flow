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
function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.setEncoding("utf8");
    let text = "";
    socket.setTimeout(2_000, () => socket.destroy(new Error("no response")));
    socket.on("data", (chunk: string) => { text += chunk; });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

test("a same-length non-ASCII token is refused without throwing out of the request listener", async () => {
  await withServer(async (url, token) => {
    const candidate = "é".repeat(32) + "a".repeat(32);
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
