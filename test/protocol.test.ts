import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTelemetryEvent, TELEMETRY_VERSION, type TelemetryEvent } from "../shared/protocol.ts";

function valid(over: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    version: TELEMETRY_VERSION,
    producerId: "pi-persona",
    producerVersion: "1.10.5",
    id: "pi-persona:session-1:1",
    seq: 1,
    ts: 1_700_000_000_000,
    sessionId: "session-1",
    workspaceId: "0123456789abcdef01234567",
    type: "instance.started",
    payload: {
      displayName: "orion",
      persona: "dev",
      model: "provider/model",
      status: "active",
      pid: 42,
      contextPercent: 12,
      exocomEnabled: true,
    },
    ...over,
  } as TelemetryEvent;
}

test("parseTelemetryEvent accepts a valid v2 envelope", () => {
  assert.deepEqual(parseTelemetryEvent(valid()), valid());
});

test("common instance lifecycle does not require pi-persona metadata", () => {
  const event = valid({
    producerId: "future.plugin",
    producerVersion: "1.0.0",
    id: "future.plugin:session-1:1",
    payload: { displayName: "future worker", status: "active" },
  });
  assert.ok(parseTelemetryEvent(event), "persona, model, process metrics and exocom are optional adapter metadata");
});

test("parseTelemetryEvent rejects unknown versions but accepts namespaced types", () => {
  assert.equal(parseTelemetryEvent({ ...valid(), version: 99 }), undefined);
  assert.ok(parseTelemetryEvent({ ...valid(), type: "other.plugin.status.changed" }));
});

test("parseTelemetryEvent rejects unsafe identity and sequence fields", () => {
  assert.equal(parseTelemetryEvent({ ...valid(), sessionId: "bad\nidentity" }), undefined);
  assert.equal(parseTelemetryEvent({ ...valid(), workspaceId: "not-a-workspace-hash" }), undefined);
  assert.equal(parseTelemetryEvent({ ...valid(), seq: 0 }), undefined);
  assert.equal(parseTelemetryEvent({ ...valid(), ts: Number.NaN }), undefined);
});

test("parseTelemetryEvent rejects non-object payloads and oversized ids", () => {
  assert.equal(parseTelemetryEvent({ ...valid(), payload: "x" }), undefined);
  assert.equal(parseTelemetryEvent({ ...valid(), id: "x".repeat(300) }), undefined);
});

test("parseTelemetryEvent rejects an empty known tool payload", () => {
  assert.equal(parseTelemetryEvent({ ...valid(), type: "tool.started", payload: {} }), undefined);
});

test("known payload projection rejects forged fields and aliases", () => {
  assert.equal(parseTelemetryEvent({ ...valid(), type: "agent.updated", payload: { id: "a", patch: { producerId: "forged", status: 42, apiKey: "SECRET" } } }), undefined);
  const generic = parseTelemetryEvent({ ...valid(), type: "other.plugin.state", payload: { state: "ready", apiKey: "SECRET", promptText: "raw" } });
  assert.deepEqual(generic?.payload, {});
});

test("unknown payloads never cross the consumer projection boundary", () => {
  const generic = parseTelemetryEvent({ ...valid(), type: "other.plugin.state", payload: { data: "sk-live", instructions: "private system prompt", parameters: { input: "tool argument" }, bearer: "jwt.secret" } });
  assert.deepEqual(generic?.payload, {});
});

test("known payload validation enforces phase and numeric bounds", () => {
  assert.equal(parseTelemetryEvent({ ...valid(), type: "tool.finished", payload: { callId: "tc", agentId: "a", name: "x", status: "running" } }), undefined);
  assert.equal(parseTelemetryEvent({ ...valid(), type: "instance.heartbeat", payload: { contextPercent: Number.NaN } }), undefined);
  assert.equal(parseTelemetryEvent({ ...valid(), type: "peers.snapshot", payload: { peers: [{ sessionId: "p", displayName: "p", contextPercent: -1, status: "online", sent: -1, received: 0 }] } }), undefined);
});

test("incremental instance validation matches producer numeric bounds and extra-field projection", () => {
  for (const payload of [
    { pid: 1.5 },
    { pid: -1 },
    { contextPercent: -0.01 },
    { contextPercent: 100.01 },
  ]) {
    assert.equal(parseTelemetryEvent({ ...valid(), type: "instance.heartbeat", payload }), undefined);
    assert.equal(parseTelemetryEvent({ ...valid(), type: "instance.updated", payload }), undefined);
  }

  const projected = parseTelemetryEvent({
    ...valid(),
    type: "instance.heartbeat",
    payload: { contextPercent: 50, producerPrivate: "discard me" },
  });
  assert.deepEqual(projected?.payload, { contextPercent: 50 });
});
