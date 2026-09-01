import { test } from "node:test";
import assert from "node:assert/strict";

import { createGraphState, reduceTelemetry, entityKey, markStale, MAX_AGENTS, MAX_STREAMS, MAX_TOOLS, type GraphState } from "../src/reducer.ts";
import { TELEMETRY_VERSION, type TelemetryEvent, type TelemetryEventType } from "../shared/protocol.ts";

function event<T extends TelemetryEventType>(
  type: T,
  payload: Extract<TelemetryEvent, { type: T }>["payload"],
  over: Partial<Omit<TelemetryEvent<T>, "type" | "payload">> = {},
): TelemetryEvent<T> {
  const seq = over.seq ?? 1;
  const sessionId = over.sessionId ?? "s1";
  return {
    version: TELEMETRY_VERSION,
    producerId: "pi-persona",
    producerVersion: "1.10.5",
    id: `pi-persona:${sessionId}:${seq}`,
    seq,
    ts: over.ts ?? 1_700_000_000_000 + seq,
    sessionId,
    workspaceId: "0123456789abcdef01234567",
    type,
    payload,
  } as unknown as TelemetryEvent<T>;
}

const instance = {
  displayName: "orion",
  persona: "dev",
  model: "provider/model",
  status: "active" as const,
  pid: 42,
  contextPercent: 10,
  exocomEnabled: true,
};

test("instance lifecycle is reduced authoritatively", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("instance.started", instance));
  assert.equal(state.instances["pi-persona::s1"]?.persona, "dev");
  assert.equal(state.instances["pi-persona::s1"]?.status, "active");

  state = reduceTelemetry(state, event("instance.updated", { persona: "reviewer", contextPercent: 63 }, { seq: 2 }));
  assert.equal(state.instances["pi-persona::s1"]?.persona, "reviewer");
  assert.equal(state.instances["pi-persona::s1"]?.contextPercent, 63);

  state = reduceTelemetry(state, event("instance.stopped", { reason: "quit" }, { seq: 3 }));
  assert.equal(state.instances["pi-persona::s1"]?.status, "stopped");
});

test("agent ids are scoped by Pi session and removed agents remain replayable", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("agent.added", {
    id: "run-1",
    parentId: "delegate-1",
    label: "orion-recon",
    kind: "subagent",
    status: "running",
    persona: "researcher",
  }));
  const key = entityKey("pi-persona", "s1", "run-1");
  assert.equal(state.agents[key]?.persona, "researcher");
  assert.equal(state.agents[key]?.parentKey, entityKey("pi-persona", "s1", "delegate-1"));

  state = reduceTelemetry(state, event("agent.updated", { id: "run-1", patch: { status: "waiting" } }, { seq: 2 }));
  assert.equal(state.agents[key]?.status, "waiting");

  state = reduceTelemetry(state, event("agent.removed", { id: "run-1", status: "done" }, { seq: 3 }));
  assert.equal(state.agents[key]?.status, "done");
  assert.ok(state.agents[key]?.endedAt);
});

test("duplicates are ignored and sequence gaps are recorded", () => {
  let state = createGraphState();
  const first = event("instance.started", instance);
  state = reduceTelemetry(state, first);
  const once = state.events.length;
  state = reduceTelemetry(state, first);
  assert.equal(state.events.length, once);

  state = reduceTelemetry(state, event("instance.heartbeat", { contextPercent: 55 }, { seq: 3 }));
  assert.deepEqual(state.gaps["pi-persona::s1"], [{ from: 2, to: 2 }]);
  assert.equal(state.lastSeq["pi-persona::s1"], 3);
});

test("sequence-gap diagnostics stay bounded for a live stream", () => {
  let state = createGraphState();
  for (let index = 1; index <= 300; index += 1) {
    state = reduceTelemetry(state, { ...event("instance.heartbeat", {}), id: `gap-${index}`, seq: index * 2 });
  }
  assert.ok((state.gaps["pi-persona::s1"]?.length ?? 0) <= 128);
  assert.ok(state.instances["pi-persona::s1"], "bounding diagnostics must not evict the live stream");
});

test("peer snapshots preserve presence-only Pi instances", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("peers.snapshot", {
    peers: [{
      sessionId: "peer-session",
      displayName: "vega",
      persona: "reviewer",
      model: "provider/other",
      contextPercent: 20,
      status: "online",
      sent: 2,
      received: 3,
    }],
  }));
  assert.equal(state.peers[entityKey("pi-persona", "s1", "peer-session")]?.displayName, "vega");
  assert.equal(state.peers[entityKey("pi-persona", "s1", "peer-session")]?.received, 3);
  assert.equal(state.instances["pi-persona::peer-session"], undefined);
});

test("intercom/exocom messages and tools retain their relation data", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("tool.started", {
    callId: "tc1", agentId: "supervisor", name: "delegate", status: "running",
  }));
  state = reduceTelemetry(state, event("tool.finished", {
    callId: "tc1", agentId: "supervisor", name: "delegate", status: "done", durationMs: 30,
  }, { seq: 2 }));
  assert.equal(state.tools[entityKey("pi-persona", "s1", "tc1")]?.durationMs, 30);

  state = reduceTelemetry(state, event("message.sent", {
    id: "m1", channel: "intercom", from: "run-1", to: "supervisor", kind: "progress",
    status: "delivered", expectsReply: false, size: 12,
  }, { seq: 3 }));
  assert.equal(state.messages.at(-1)?.channel, "intercom");
  assert.equal(state.messages.at(-1)?.fromKey, entityKey("pi-persona", "s1", "run-1"));
});

test("completed tool history is bounded while running calls are kept", () => {
  let state = createGraphState();
  const completed = MAX_TOOLS + 200;
  let seq = 0;
  for (let index = 0; index < completed; index += 1) {
    const callId = `tc-${index}`;
    state = reduceTelemetry(state, event("tool.started", { callId, agentId: "supervisor", name: "delegate", status: "running" }, { seq: (seq += 1) }));
    state = reduceTelemetry(state, event("tool.finished", { callId, agentId: "supervisor", name: "delegate", status: "done", durationMs: 1 }, { seq: (seq += 1) }));
  }
  state = reduceTelemetry(state, event("tool.started", { callId: "live", agentId: "supervisor", name: "delegate", status: "running" }, { seq: (seq += 1) }));

  assert.ok(Object.keys(state.tools).length <= MAX_TOOLS + 1, `${Object.keys(state.tools).length} tool views retained`);
  assert.ok(state.tools[entityKey("pi-persona", "s1", "live")], "a running call is never evicted");
  assert.ok(state.tools[entityKey("pi-persona", "s1", `tc-${completed - 1}`)], "the newest completed call survives");
  assert.equal(state.tools[entityKey("pi-persona", "s1", "tc-0")], undefined, "the oldest completed call is dropped");
});

test("ended agent history is bounded but ancestors of survivors are retained", () => {
  let state = createGraphState();
  let seq = 0;
  const added = (id: string, parentId?: string) => event("agent.added", { id, label: id, kind: "subagent", status: "running", ...(parentId ? { parentId } : {}) }, { seq: (seq += 1) });
  state = reduceTelemetry(state, added("root"));
  state = reduceTelemetry(state, added("mid", "root"));
  state = reduceTelemetry(state, added("leaf", "mid"));
  state = reduceTelemetry(state, event("agent.removed", { id: "root", status: "done" }, { seq: (seq += 1) }));
  state = reduceTelemetry(state, event("agent.removed", { id: "mid", status: "done" }, { seq: (seq += 1) }));
  for (let index = 0; index < MAX_AGENTS + 200; index += 1) {
    state = reduceTelemetry(state, added(`run-${index}`));
    state = reduceTelemetry(state, event("agent.removed", { id: `run-${index}`, status: "done" }, { seq: (seq += 1) }));
  }

  assert.ok(Object.keys(state.agents).length <= MAX_AGENTS + 3, `${Object.keys(state.agents).length} agent views retained`);
  assert.ok(state.agents[entityKey("pi-persona", "s1", "leaf")], "a running agent is never evicted");
  assert.ok(state.agents[entityKey("pi-persona", "s1", "mid")], "the parent of a surviving agent is exempt from the cap");
  assert.ok(state.agents[entityKey("pi-persona", "s1", "root")], "exemption reaches every ancestor, not just the direct parent");
  assert.equal(state.agents[entityKey("pi-persona", "s1", "run-0")], undefined, "the oldest ended agent without dependents is dropped");
});

test("reviving an agent clears the endedAt a terminal patch stamped on it", () => {
  let state = createGraphState();
  let seq = 0;
  const key = entityKey("pi-persona", "s1", "run-1");
  state = reduceTelemetry(state, event("agent.added", { id: "run-1", label: "run-1", kind: "subagent", status: "running" }, { seq: (seq += 1) }));
  state = reduceTelemetry(state, event("agent.updated", { id: "run-1", patch: { status: "stopped" } }, { seq: (seq += 1) }));
  assert.ok(state.agents[key]?.endedAt, "a terminal patch ends the agent");
  state = reduceTelemetry(state, event("agent.updated", { id: "run-1", patch: { status: "running" } }, { seq: (seq += 1) }));
  assert.equal(state.agents[key]?.endedAt, undefined, "a live agent must not keep an end timestamp");
});

test("a live agent carrying a stray endedAt still survives the cap", () => {
  let state = createGraphState();
  let seq = 0;
  const added = (id: string) => event("agent.added", { id, label: id, kind: "subagent", status: "running" }, { seq: (seq += 1) });
  state = reduceTelemetry(state, added("live"));
  const key = entityKey("pi-persona", "s1", "live");
  // Eviction classifies by status, so no path that stamps an endedAt on running work can turn it
  // into cap fodder.
  state = { ...state, agents: { ...state.agents, [key]: { ...state.agents[key]!, endedAt: 1 } } };
  for (let index = 0; index < MAX_AGENTS + 50; index += 1) {
    state = reduceTelemetry(state, added(`run-${index}`));
    state = reduceTelemetry(state, event("agent.removed", { id: `run-${index}`, status: "done" }, { seq: (seq += 1) }));
  }
  assert.equal(state.agents[key]?.status, "running", "a running agent is never evicted");
});

test("entities that never reach a terminal event are bounded too", () => {
  let state = createGraphState();
  let seq = 0;
  const started = 5_000;
  for (let index = 0; index < started; index += 1) {
    state = reduceTelemetry(state, event("tool.started", { callId: `tc-${index}`, agentId: "supervisor", name: "delegate", status: "running" }, { seq: (seq += 1) }));
    state = reduceTelemetry(state, event("agent.added", { id: `run-${index}`, label: "run", kind: "subagent", status: "running" }, { seq: (seq += 1) }));
  }
  // The hard ceiling is a small multiple of the ended-history cap: a producer that never finishes
  // its work still cannot grow either map without limit.
  assert.ok(Object.keys(state.tools).length <= MAX_TOOLS * 2, `${Object.keys(state.tools).length} tool views retained`);
  assert.ok(Object.keys(state.agents).length <= MAX_AGENTS * 2, `${Object.keys(state.agents).length} agent views retained`);
  assert.ok(state.tools[entityKey("pi-persona", "s1", `tc-${started - 1}`)], "the newest running call survives");
  assert.ok(state.agents[entityKey("pi-persona", "s1", `run-${started - 1}`)], "the newest running agent survives");
});

test("a foreign producer's in-flight call is live work, not ended history", () => {
  let state = createGraphState();
  let seq = 0;
  // The contract lets any producer name an in-flight call with its own word, so liveness has to be a
  // terminal denylist here too — an allowlist of "running" would file every one of these as history.
  const key = entityKey("other.plugin", "s2", "tc-live");
  const inFlight = (callId: string) => ({
    version: TELEMETRY_VERSION, producerId: "other.plugin", producerVersion: "1.0.0",
    id: `other.plugin:s2:${(seq += 1)}`, seq, ts: 1_700_000_000_000 + seq, sessionId: "s2",
    workspaceId: "0123456789abcdef01234567", type: "tool.started" as TelemetryEventType,
    payload: { callId, agentId: "worker", name: "job", status: "executing" },
  }) as TelemetryEvent;
  state = reduceTelemetry(state, inFlight("tc-live"));
  for (let index = 0; index < MAX_TOOLS + 200; index += 1) state = reduceTelemetry(state, inFlight(`tc-${index}`));

  assert.equal(state.tools[key]?.status, "executing", "an unrecognized status is live work, never cap fodder");
});

test("an ancestor chain past the ceiling is re-rooted, not left unbounded", () => {
  let state = createGraphState();
  let seq = 0;
  const ceiling = MAX_AGENTS * 2;
  // Every agent names the previous one as its parent, so ancestor exemption covers the whole map: the
  // ceiling can only make progress by dropping leaves.
  for (let index = 0; index < ceiling + 500; index += 1) {
    state = reduceTelemetry(state, event("agent.added", {
      id: `run-${index}`, label: "run", kind: "subagent", status: "running",
      ...(index > 0 ? { parentId: `run-${index - 1}` } : {}),
    }, { seq: (seq += 1) }));
  }

  const retained = Object.keys(state.agents).length;
  assert.ok(retained <= ceiling, `${retained} agents retained past a ceiling of ${ceiling}`);
  assert.ok(state.agents[entityKey("pi-persona", "s1", `run-${ceiling + 499}`)], "the newest agent survives");
  for (const agent of Object.values(state.agents)) {
    if (agent.parentKey === undefined) continue;
    assert.ok(state.agents[agent.parentKey], `${agent.id} outlived its parent and detached the tree`);
  }
});

test("the ended-entity bound prunes with hysteresis, not on every event past the cap", () => {
  let state = createGraphState();
  let seq = 0;
  let rebuilds = 0;
  for (let index = 0; index < MAX_TOOLS * 2; index += 1) {
    const callId = `tc-${index}`;
    state = reduceTelemetry(state, event("tool.started", { callId, agentId: "supervisor", name: "delegate", status: "running" }, { seq: (seq += 1) }));
    const before = Object.keys(state.tools).length;
    state = reduceTelemetry(state, event("tool.finished", { callId, agentId: "supervisor", name: "delegate", status: "done", durationMs: 1 }, { seq: (seq += 1) }));
    if (Object.keys(state.tools).length < before) rebuilds += 1;
  }
  assert.ok(rebuilds <= MAX_TOOLS / 50, `${rebuilds} sort-and-rebuild passes over ${MAX_TOOLS} events past the cap`);
});

test("per-stream index maps are bounded for a producer that never opens an instance", () => {
  let state = createGraphState();
  const peer = { sessionId: "peer", displayName: "peer", persona: "", model: "", contextPercent: 0, status: "online" as const, sent: 1, received: 1 };
  // Nothing here writes an instance view, and index cleanup used to be derived from `instances` alone,
  // so a producer that only reports agents, peers or messages grew lastSeq/gaps/peers forever.
  for (let index = 0; index < 1_500; index += 1) {
    const sessionId = `s-${index}`;
    // Opening at seq 2 leaves a gap behind as well, so the gap map is exercised with the rest.
    state = reduceTelemetry(state, event("agent.added", { id: "run", label: "run", kind: "subagent", status: "done" }, { seq: 2, sessionId }));
    state = reduceTelemetry(state, event("peers.snapshot", { peers: [peer] }, { seq: 3, sessionId }));
  }
  assert.ok(Object.keys(state.lastSeq).length <= MAX_STREAMS, `${Object.keys(state.lastSeq).length} sequence cursors retained`);
  assert.ok(Object.keys(state.gaps).length <= MAX_STREAMS, `${Object.keys(state.gaps).length} gap lists retained`);
  assert.ok(Object.keys(state.peers).length <= MAX_STREAMS, `${Object.keys(state.peers).length} peer rows retained`);
  assert.ok(state.lastSeq[entityKey("pi-persona", "s-1499")], "the newest stream keeps its sequence cursor");
});

test("a producer that never stops a stream still cannot grow the index without limit", () => {
  let state = createGraphState();
  // Every stream here holds a running agent, so every one is exempt from the terminal budget: the
  // ceiling above it is all that is left to bound the maps.
  for (let index = 0; index < 1_500; index += 1) {
    state = reduceTelemetry(state, event("agent.added", { id: "run", label: "run", kind: "subagent", status: "running" }, { sessionId: `s-${index}` }));
  }
  assert.ok(Object.keys(state.lastSeq).length <= MAX_STREAMS, `${Object.keys(state.lastSeq).length} sequence cursors retained`);
  assert.ok(Object.keys(state.streams).length <= MAX_STREAMS, `${Object.keys(state.streams).length} streams registered`);
  assert.ok(state.agents[entityKey("pi-persona", "s-1499", "run")], "the newest stream survives the ceiling");
});

test("an event on a known stream does not rebuild the stream registry", () => {
  let state = createGraphState();
  state = reduceTelemetry(state, event("instance.started", instance));
  const registered = state.streams;
  for (let seq = 2; seq <= 200; seq += 1) state = reduceTelemetry(state, event("instance.heartbeat", { contextPercent: seq % 101 }, { seq }));
  // Registration rides the edges that can grow a map — a new stream, a stop — never the hot path.
  assert.equal(state.streams, registered, "the stream registry was copied for an event that cannot change it");
  assert.equal(state.streams[entityKey("pi-persona", "s1")]?.producerId, "pi-persona");
});

/** A graph as a consumer may hand one back: persisted, or produced by a reducer that predates the stream
 *  registry. Neither the registry nor its clock is there to fold against. */
function registrylessGraph(): GraphState {
  const legacy: GraphState = {
    ...createGraphState(),
    instances: { [entityKey("pi-persona", "vintage")]: { ...instance, status: "stopped", producerId: "pi-persona", sessionId: "vintage", startedAt: 1, updatedAt: 2 } },
    lastSeq: { [entityKey("pi-persona", "vintage")]: 5 },
  };
  delete (legacy as Partial<GraphState>).streams;
  delete (legacy as Partial<GraphState>).streamClock;
  return legacy;
}

test("a graph folded from before the stream registry is tolerated, not thrown at", () => {
  let state = reduceTelemetry(registrylessGraph(), event("instance.started", instance));
  assert.equal(state.instances[entityKey("pi-persona", "s1")]?.persona, "dev");
  assert.equal(state.streams[entityKey("pi-persona", "s1")]?.producerId, "pi-persona", "the folded event registers its own stream");
  assert.equal(state.instances[entityKey("pi-persona", "vintage")]?.status, "stopped", "the folded graph keeps what it already held");
  state = markStale(state, 1_700_000_100_000, 100);
  assert.equal(state.instances[entityKey("pi-persona", "s1")]?.status, "stale");
});

test("a stream the registry never stamped is not the first thing the ceiling evicts", () => {
  // "vintage" comes from a folded graph, so it carries no arrival ordinal at all. An unknown age must not
  // rank it below every stream that does have one and make it the first victim.
  let state = registrylessGraph();
  // Live streams are exempt from the terminal budget, so these are what push the retained set past the
  // ceiling and force it to pick victims out of the terminal ones.
  for (let index = 0; index < 300; index += 1) {
    state = reduceTelemetry(state, event("agent.added", { id: "run", label: "run", kind: "subagent", status: "running" }, { sessionId: `live-${index}` }));
  }
  for (let index = 0; index < 300; index += 1) {
    const sessionId = `done-${index}`;
    state = reduceTelemetry(state, event("instance.started", instance, { sessionId }));
    state = reduceTelemetry(state, event("instance.stopped", { reason: "done" }, { seq: 2, sessionId }));
  }
  assert.ok(state.instances[entityKey("pi-persona", "vintage")], "an unstamped stream was ranked as the oldest possible arrival");
  assert.ok(Object.keys(state.streams).length <= MAX_STREAMS, `${Object.keys(state.streams).length} streams registered`);
});

test("above the stream ceiling the churn is amortized, not paid on every event", () => {
  let state = createGraphState();
  const sessions = 600;
  for (let index = 0; index < sessions; index += 1) {
    state = reduceTelemetry(state, event("instance.started", instance, { sessionId: `s-${index}` }));
    state = reduceTelemetry(state, event("agent.added", { id: "run", label: "run", kind: "subagent", status: "running" }, { seq: 2, sessionId: `s-${index}` }));
  }
  // Every one of these is still alive, so a stream the ceiling evicted re-registers on its very next
  // heartbeat and pushes another one out. Pruning below the ceiling rather than to it is what keeps that
  // from costing a sort-and-rebuild per event.
  let rebuilds = 0;
  let seq = 2;
  const events = sessions * 5;
  for (let round = 0; round < 5; round += 1) {
    for (let index = 0; index < sessions; index += 1) {
      // Counting registered streams cannot see a pass that drops many and re-registers one. Eviction
      // writes every per-stream map out at once and nothing else in this loop touches `agents`, so a
      // fresh one is the pass itself.
      const before = state.agents;
      state = reduceTelemetry(state, event("instance.heartbeat", { contextPercent: seq % 101 }, { seq: (seq += 1), sessionId: `s-${index}` }));
      if (state.agents !== before) rebuilds += 1;
    }
  }
  assert.ok(rebuilds <= events / 40, `${rebuilds} sort-and-rebuild passes over ${events} events above the ceiling`);
  assert.ok(Object.keys(state.streams).length <= MAX_STREAMS, `${Object.keys(state.streams).length} streams registered`);
  assert.ok(state.instances[entityKey("pi-persona", `s-${sessions - 1}`)], "an evicted live stream comes back on its next event");
});

test("a folded registry without its clock resumes above the stamps it already holds", () => {
  const legacy: GraphState = { ...createGraphState(), streams: { [entityKey("pi-persona", "old")]: { producerId: "pi-persona", seen: 40 } } };
  delete (legacy as Partial<GraphState>).streamClock;
  const state = reduceTelemetry(legacy, event("instance.started", instance));
  assert.ok((state.streams[entityKey("pi-persona", "s1")]?.seen ?? 0) > 40, "a new arrival must not rank as older than a stamp already in the registry");
});
