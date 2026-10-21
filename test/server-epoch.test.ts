import { after, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { EventStore } from "../src/event-store.ts";
import { startServer, type FlowServer } from "../src/server.ts";
import { TELEMETRY_VERSION, type TelemetryEvent } from "../shared/protocol.ts";
import { createFixtureScope } from "./setup/fixture-scope.ts";

const fixtures = createFixtureScope();
after(() => fixtures.cleanup());
const privateServiceId = "private-service-identity";
const privateControlToken = "private-control-credential";

function event(seq: number): TelemetryEvent {
  return {
    version: TELEMETRY_VERSION, producerId: "epoch-test", producerVersion: "1", id: `s:${seq}`,
    seq, ts: seq, sessionId: "s", workspaceId: "0123456789abcdef01234567",
    type: "instance.heartbeat", payload: { contextPercent: seq },
  };
}

async function sharedServer(store: EventStore): Promise<FlowServer> {
  const staticDir = fixtures.tempDirectory("flow-stream-epoch-");
  writeFileSync(join(staticDir, "index.html"), "ok");
  const server = await startServer({
    port: 0, store, staticDir, token: "Ab12", serviceId: privateServiceId,
    controlToken: privateControlToken,
    controlPlane: {
      register: () => ({ workspaceId: "local" }), heartbeat: () => true,
      unregister: () => true, ingest: () => ({ accepted: 0, rejected: 0 }),
    },
  });
  fixtures.trackHandle(() => server.close());
  return server;
}

async function snapshot(server: FlowServer): Promise<{ cursor: number; streamEpoch?: string }> {
  const url = new URL("/api/snapshot", server.url);
  url.searchParams.set("token", server.token);
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  assert.equal(response.status, 200);
  return await response.json() as { cursor: number; streamEpoch?: string };
}

async function firstFrame(server: FlowServer, query: Record<string, string>, lastEventId?: string): Promise<string> {
  const url = new URL("/api/stream", server.url);
  url.searchParams.set("token", server.token);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    ...(lastEventId === undefined ? {} : { headers: { "Last-Event-ID": lastEventId } }),
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\ndata: ")) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) break;
    }
    return text;
  } finally { await reader.cancel(); }
}

test("shared snapshots and SSE IDs expose an independent public stream epoch", async () => {
  const store = new EventStore();
  store.append(event(1)); store.append(event(2));
  const server = await sharedServer(store);
  try {
    const initial = await snapshot(server);
    assert.match(initial.streamEpoch ?? "", /^[0-9a-f-]{36}$/i);
    assert.notEqual(initial.streamEpoch, privateServiceId);
    const frame = await firstFrame(server, { after: "1", streamEpoch: initial.streamEpoch! });
    assert.ok(frame.includes(`id: ${initial.streamEpoch}:2\n`));
    assert.match(frame, /event: telemetry/);
    assert.doesNotMatch(frame, /event: snapshot/);
    assert.ok(!frame.includes(privateServiceId) && !frame.includes(privateControlToken));
    const resumed = await firstFrame(server, { after: "0", streamEpoch: "obsolete" }, `${initial.streamEpoch}:1`);
    assert.match(resumed, /event: telemetry/);
    assert.doesNotMatch(resumed, /event: snapshot/);
    const reset = await firstFrame(server, {});
    assert.ok(reset.includes(`"streamEpoch":"${initial.streamEpoch}"`));
    assert.ok(reset.includes(`id: ${initial.streamEpoch}:2\n`));
  } finally { await server.close(); }
});

test("shared streams replace cursors from another daemon generation with an authoritative snapshot", async () => {
  const first = await sharedServer(new EventStore());
  let previousEpoch: string;
  try {
    const initial = await snapshot(first);
    assert.equal(typeof initial.streamEpoch, "string");
    previousEpoch = initial.streamEpoch!;
  } finally { await first.close(); }

  const store = new EventStore();
  store.append(event(1)); store.append(event(2));
  const replacement = await sharedServer(store);
  try {
    const current = await snapshot(replacement);
    assert.notEqual(current.streamEpoch, previousEpoch);
    for (const [query, header] of [
      [{ after: "1", streamEpoch: previousEpoch }, undefined],
      [{ after: "1", streamEpoch: current.streamEpoch! }, `${previousEpoch}:1`],
      [{ after: "1", streamEpoch: current.streamEpoch! }, "1"],
      [{ after: "1" }, undefined],
    ] as const) {
      const frame = await firstFrame(replacement, query, header);
      assert.match(frame, /event: snapshot/);
      assert.doesNotMatch(frame, /event: telemetry/);
      assert.ok(frame.includes(`id: ${current.streamEpoch}:2\n`));
    }
  } finally { await replacement.close(); }
});
