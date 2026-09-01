import { test } from "node:test";
import assert from "node:assert/strict";

import { createGraphState, entityKey, markStale, MAX_INACTIVE_STREAMS, MAX_STREAMS, reduceTelemetry } from "../src/reducer.ts";
import { TELEMETRY_VERSION, type TelemetryEvent, type TelemetryEventType } from "../shared/protocol.ts";

function event<T extends TelemetryEventType>(producerId: string, type: T, payload: Extract<TelemetryEvent, { type: T }>['payload'], seq = 1, sessionId = "s"): TelemetryEvent {
  return { version: TELEMETRY_VERSION, producerId, producerVersion: "1.0.0", id: `${producerId}:${sessionId}:${seq}`, seq, ts: seq, sessionId, workspaceId: "0123456789abcdef01234567", type, payload } as unknown as TelemetryEvent;
}

test("entity and sequence keys include producer identity", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("a", "agent.added", { id: "same", label: "a", kind: "subagent", status: "running" }));
  state = reduceTelemetry(state, event("b", "agent.added", { id: "same", label: "b", kind: "subagent", status: "running" }));
  assert.equal(state.agents[entityKey("a", "s", "same")]?.label, "a");
  assert.equal(state.agents[entityKey("b", "s", "same")]?.label, "b");
  assert.equal(state.lastSeq["a::s"], 1);
  assert.equal(state.lastSeq["b::s"], 1);
});

test("peer snapshots remove peers absent from the newest snapshot", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("a", "peers.snapshot", { peers: [{ sessionId: "dead", displayName: "dead", persona: "", model: "", contextPercent: 0, status: "online", sent: 0, received: 0 }] }));
  state = reduceTelemetry(state, event("a", "peers.snapshot", { peers: [] }, 2));
  assert.deepEqual(state.peers, {});
});

test("peer replacement is scoped to the reporting session", () => {
  let state = createGraphState();
  const peer = { sessionId: "peer", displayName: "peer", persona: "", model: "", contextPercent: 0, status: "online" as const, sent: 0, received: 0 };
  state = reduceTelemetry(state, event("a", "peers.snapshot", { peers: [peer] }, 1));
  state = reduceTelemetry(state, event("a", "peers.snapshot", { peers: [peer] }, 1, "other-reporter"));
  state = reduceTelemetry(state, event("a", "peers.snapshot", { peers: [] }, 2));
  assert.ok(state.peers[entityKey("a", "other-reporter", "peer")]);
});

test("canonical exocom endpoints resolve to the reporter-scoped peer key", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("a", "message.sent", { id: "m", channel: "exocom", from: "s", to: "peer-session-uuid", kind: "message", status: "queued", expectsReply: false, size: 1 }));
  state = reduceTelemetry(state, event("a", "message.sent", { id: "m", channel: "exocom", from: "s", to: "peer-session-uuid", kind: "message", status: "delivered", expectsReply: false, size: 1 }, 2));
  assert.equal(state.messages[0]?.toKey, entityKey("a", "s", "peer-session-uuid"));
  assert.equal(state.messages[0]?.fromKey, entityKey("a", "s"));
  assert.equal(state.messages.length, 1, "the current graph coalesces lifecycle updates for one logical message");
  assert.equal(state.messages[0]?.status, "delivered");
});

test("terminal stream retention is bounded without evicting an active instance", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("a", "instance.started", { displayName: "live", persona: "", model: "", status: "active", pid: 1, contextPercent: 0, exocomEnabled: false }, 1, "live"));
  for (let i = 0; i < 300; i += 1) {
    const session = `done-${i}`;
    state = reduceTelemetry(state, event("a", "instance.started", { displayName: session, persona: "", model: "", status: "active", pid: 1, contextPercent: 0, exocomEnabled: false }, 1, session));
    state = reduceTelemetry(state, event("a", "instance.stopped", { reason: "done" }, 2, session));
  }
  assert.ok(state.instances[entityKey("a", "live")]);
  assert.ok(Object.keys(state.instances).length <= 257);
  assert.ok(Object.keys(state.lastSeq).length <= 257);
});

test("crashed stale-stream retention is bounded without evicting a recent active instance", () => {
  let state = createGraphState();
  for (let index = 0; index < 300; index += 1) {
    const session = `crashed-${index}`;
    state = reduceTelemetry(state, { ...event("a", "instance.started", { displayName: session, status: "active" }, 1, session), ts: index });
  }
  state = reduceTelemetry(state, { ...event("a", "instance.started", { displayName: "live", status: "active" }, 1, "live"), ts: 10_000 });
  state = markStale(state, 10_050, 100);
  assert.equal(state.instances[entityKey("a", "live")]?.status, "active");
  assert.ok(Object.keys(state.instances).length <= 257);
  assert.ok(Object.values(state.instances).filter((instance) => instance.status === "stale").length <= 256);
});

test("instance stop terminalizes tools left running by a crashed producer", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("a", "tool.started", { callId: "tc", agentId: "supervisor", name: "delegate", status: "running" }));
  state = reduceTelemetry(state, event("a", "instance.stopped", { reason: "crash" }, 2));
  assert.equal(state.tools[entityKey("a", "s", "tc")]?.status, "failed");
  assert.equal(state.tools[entityKey("a", "s", "tc")]?.endedAt, 2);
});

test("instance stop terminalizes agents left running by a crashed producer", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("a", "agent.added", { id: "run", label: "run", kind: "subagent", status: "running" }));
  state = reduceTelemetry(state, event("a", "instance.stopped", { reason: "crash" }, 2));
  assert.equal(state.agents[entityKey("a", "s", "run")]?.status, "stopped");
  assert.equal(state.agents[entityKey("a", "s", "run")]?.endedAt, 2);
});

test("crashed streams go stale whatever status vocabulary their producer uses", () => {
  let state = createGraphState();
  for (let index = 0; index < 300; index += 1) {
    const session = `running-${index}`;
    state = reduceTelemetry(state, { ...event("a", "instance.started", { displayName: session, status: "running" }, 1, session), ts: index });
  }
  state = markStale(state, 10_000, 100);
  assert.ok(Object.values(state.instances).every((instance) => instance.status === "stale"), "a foreign live status must still age out");
  assert.ok(Object.keys(state.instances).length <= MAX_INACTIVE_STREAMS);
});

test("a heartbeat cannot exempt a stream from staleness with an unknown status", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("a", "instance.started", { displayName: "x", status: "active" }, 1));
  state = reduceTelemetry(state, event("a", "instance.heartbeat", { status: "busy" }, 2));
  state = markStale(state, 10_000, 100);
  assert.equal(state.instances[entityKey("a", "s")]?.status, "stale");
});

test("a stale transition leaves the stream's work alone", () => {
  // Replay compares a historical ts against the wall clock, so a *live* session's own log makes its
  // stream look stale on the very first pass. Only instance.stopped may terminalize running work.
  let state = createGraphState();
  state = reduceTelemetry(state, event("a", "instance.started", { displayName: "x", status: "running" }, 1));
  state = reduceTelemetry(state, event("a", "agent.added", { id: "run", label: "run", kind: "subagent", status: "running" }, 2));
  state = reduceTelemetry(state, event("a", "tool.started", { callId: "tc", agentId: "run", name: "delegate", status: "running" }, 3));
  state = markStale(state, 10_000, 100);
  assert.equal(state.instances[entityKey("a", "s")]?.status, "stale");
  assert.equal(state.agents[entityKey("a", "s", "run")]?.status, "running");
  assert.equal(state.agents[entityKey("a", "s", "run")]?.endedAt, undefined);
  assert.equal(state.tools[entityKey("a", "s", "tc")]?.status, "running");
  assert.equal(state.tools[entityKey("a", "s", "tc")]?.endedAt, undefined);
});

test("one producer's churn cannot evict another producer's stale-but-working stream", () => {
  let state = createGraphState();
  // "steady" is alive and busy, but its own log is old, so the wall-clock guess relabels it stale. That
  // is a guess: only instance.stopped is authority, and the work under it is still in flight.
  state = reduceTelemetry(state, { ...event("steady", "instance.started", { displayName: "steady", status: "active" }, 1), ts: 1 });
  state = reduceTelemetry(state, { ...event("steady", "agent.added", { id: "run", label: "run", kind: "subagent", status: "running" }, 2), ts: 2 });
  state = reduceTelemetry(state, { ...event("steady", "tool.started", { callId: "tc", agentId: "run", name: "delegate", status: "running" }, 3), ts: 3 });
  state = markStale(state, 1_000_000, 100);
  assert.equal(state.instances[entityKey("steady", "s")]?.status, "stale");

  for (let index = 0; index < 300; index += 1) {
    const session = `churn-${index}`;
    state = reduceTelemetry(state, { ...event("churn", "instance.started", { displayName: session, status: "active" }, 1, session), ts: 1_000_000 + index });
    state = reduceTelemetry(state, { ...event("churn", "instance.stopped", { reason: "done" }, 2, session), ts: 1_000_000 + index });
  }

  assert.ok(state.instances[entityKey("steady", "s")], "a stale guess is not a stop: work in flight keeps its stream");
  assert.equal(state.agents[entityKey("steady", "s", "run")]?.status, "running");
  assert.equal(state.tools[entityKey("steady", "s", "tc")]?.status, "running");
  assert.equal(state.lastSeq["steady::s"], 3, "the evicted stream took its sequence cursor with it");
  assert.ok(Object.keys(state.instances).length <= MAX_INACTIVE_STREAMS + 1, `${Object.keys(state.instances).length} streams retained`);
});

test("the terminal budget is split fairly between producers", () => {
  let state = createGraphState();
  // "quiet" stopped one session, ancient by its own clock. "churn" stops hundreds and stamps every one
  // of them with a far-future ts — a producer supplies ts, so ranking on it hands over the whole budget.
  state = reduceTelemetry(state, { ...event("quiet", "instance.started", { displayName: "quiet", status: "active" }, 1), ts: 1 });
  state = reduceTelemetry(state, { ...event("quiet", "instance.stopped", { reason: "done" }, 2), ts: 2 });
  for (let index = 0; index < 400; index += 1) {
    const session = `churn-${index}`;
    state = reduceTelemetry(state, { ...event("churn", "instance.started", { displayName: session, status: "active" }, 1, session), ts: Number.MAX_SAFE_INTEGER - 1 });
    state = reduceTelemetry(state, { ...event("churn", "instance.stopped", { reason: "done" }, 2, session), ts: Number.MAX_SAFE_INTEGER });
  }

  assert.ok(state.instances[entityKey("quiet", "s")], "one producer's churn must not spend another producer's share");
  assert.ok(Object.keys(state.instances).length <= MAX_INACTIVE_STREAMS, `${Object.keys(state.instances).length} streams retained`);
  assert.ok(state.instances[entityKey("churn", "churn-399")], "the churning producer still keeps its newest sessions");
});

test("one producer's own churn cannot evict its stale-but-working stream", () => {
  // The multi-producer case above passes on the fair share alone. The exemption is what has to carry
  // this one: every stream here belongs to the same producer, so there is no other share to spend.
  let state = createGraphState();
  state = reduceTelemetry(state, { ...event("solo", "instance.started", { displayName: "worker", status: "active" }, 1, "worker"), ts: 1 });
  state = reduceTelemetry(state, { ...event("solo", "agent.added", { id: "run", label: "run", kind: "subagent", status: "running" }, 2, "worker"), ts: 2 });
  state = reduceTelemetry(state, { ...event("solo", "tool.started", { callId: "tc", agentId: "run", name: "delegate", status: "running" }, 3, "worker"), ts: 3 });
  state = markStale(state, 1_000_000, 100);
  assert.equal(state.instances[entityKey("solo", "worker")]?.status, "stale");

  for (let index = 0; index < 300; index += 1) {
    const session = `churn-${index}`;
    state = reduceTelemetry(state, { ...event("solo", "instance.started", { displayName: session, status: "active" }, 1, session), ts: 1_000_000 + index });
    state = reduceTelemetry(state, { ...event("solo", "instance.stopped", { reason: "done" }, 2, session), ts: 1_000_000 + index });
  }

  assert.ok(state.instances[entityKey("solo", "worker")], "a stale guess is not a stop: work in flight keeps its stream");
  assert.equal(state.agents[entityKey("solo", "worker", "run")]?.status, "running");
  assert.equal(state.tools[entityKey("solo", "worker", "tc")]?.status, "running");
  assert.ok(Object.keys(state.instances).length <= MAX_INACTIVE_STREAMS + 1, `${Object.keys(state.instances).length} streams retained`);
});

test("the terminal budget ranks one producer's streams on arrival, not on the ts it supplies", () => {
  // Single producer, so the fair share cannot decide this: only the arrival ordinal can. "forged" is the
  // first stream to arrive and stamps itself with a far-future ts — ranking on a producer's own clock
  // would let it outlive every stream that came after it.
  let state = createGraphState();
  state = reduceTelemetry(state, { ...event("solo", "instance.started", { displayName: "forged", status: "active" }, 1, "forged"), ts: Number.MAX_SAFE_INTEGER - 1 });
  state = reduceTelemetry(state, { ...event("solo", "instance.stopped", { reason: "done" }, 2, "forged"), ts: Number.MAX_SAFE_INTEGER });
  for (let index = 0; index < 300; index += 1) {
    const session = `later-${index}`;
    state = reduceTelemetry(state, { ...event("solo", "instance.started", { displayName: session, status: "active" }, 1, session), ts: index });
    state = reduceTelemetry(state, { ...event("solo", "instance.stopped", { reason: "done" }, 2, session), ts: index });
  }

  assert.equal(state.instances[entityKey("solo", "forged")], undefined, "the oldest arrival goes first however new its producer claims it is");
  assert.ok(state.instances[entityKey("solo", "later-299")], "the newest arrivals are the ones kept");
});

test("the stream ceiling takes terminal streams before the live ones that outlived them", () => {
  // A stop restamps its stream, so every terminal stream below carries a NEWER arrival ordinal than the
  // live sessions above it. Ranking the whole retained set on arrival alone therefore evicts the live
  // veteran first and keeps the stopped sessions — backwards.
  let state = createGraphState();
  state = reduceTelemetry(state, event("solo", "instance.started", { displayName: "veteran", status: "active" }, 1, "veteran"));
  for (let index = 0; index < 300; index += 1) {
    const session = `live-${index}`;
    state = reduceTelemetry(state, event("solo", "instance.started", { displayName: session, status: "active" }, 1, session));
  }
  for (let index = 0; index < 300; index += 1) {
    const session = `done-${index}`;
    state = reduceTelemetry(state, event("solo", "instance.started", { displayName: session, status: "active" }, 1, session));
    state = reduceTelemetry(state, event("solo", "instance.stopped", { reason: "done" }, 2, session));
  }

  assert.ok(state.instances[entityKey("solo", "veteran")], "the oldest live stream must outlive a stopped one");
  const live = Object.values(state.instances).filter((instance) => instance.status === "active");
  assert.equal(live.length, 301, "no live stream may be dropped while a terminal one is still retained");
  assert.ok(Object.keys(state.streams).length <= MAX_STREAMS, `${Object.keys(state.streams).length} streams registered`);
});

test("past the ceiling the exempt remainder is split between producers, not taken oldest-first", () => {
  // Nothing here is evictable: both producers leave every stream running, so the ceiling has to choose
  // between exempt streams. "quiet" arrived first and asks for ten slots; taking the oldest would spend
  // its whole share on a producer that opens hundreds.
  let state = createGraphState();
  for (let index = 0; index < 10; index += 1) {
    state = reduceTelemetry(state, event("quiet", "agent.added", { id: "run", label: "run", kind: "subagent", status: "running" }, 1, `q-${index}`));
  }
  for (let index = 0; index < 600; index += 1) {
    state = reduceTelemetry(state, event("flood", "agent.added", { id: "run", label: "run", kind: "subagent", status: "running" }, 1, `f-${index}`));
  }

  for (let index = 0; index < 10; index += 1) {
    assert.ok(state.agents[entityKey("quiet", `q-${index}`, "run")], `q-${index} lost its share to another producer's flood`);
  }
  assert.ok(state.agents[entityKey("flood", "f-599", "run")], "the flooding producer still keeps its newest streams");
  assert.ok(Object.keys(state.streams).length <= MAX_STREAMS, `${Object.keys(state.streams).length} streams registered`);
});
