import { test } from "node:test";
import assert from "node:assert/strict";

import { EventStore } from "../src/event-store.ts";
import { TELEMETRY_VERSION, type TelemetryEvent } from "../shared/protocol.ts";

function event(seq: number, id = `session:${seq}`): TelemetryEvent {
  return {
    version: TELEMETRY_VERSION,
    producerId: "pi-persona",
    producerVersion: "1.10.5",
    id,
    seq,
    ts: seq,
    sessionId: "session",
    workspaceId: "0123456789abcdef01234567",
    type: "instance.heartbeat",
    payload: { contextPercent: seq },
  };
}

test("EventStore assigns a global cursor, deduplicates, reduces, and notifies", () => {
  const store = new EventStore(4);
  const seen: number[] = [];
  store.subscribe((delta) => seen.push(delta.cursor));
  assert.equal(store.append(event(1)), 1);
  assert.equal(store.append(event(1)), undefined);
  assert.equal(store.append({ ...event(1, "other:1"), sessionId: "other" }), 2);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(store.snapshot().state.instances["pi-persona::session"]!.contextPercent, 1);
  assert.deepEqual(store.backlog(0)?.map((d) => d.cursor), [1, 2]);
});

test("delimiter-bearing stream identities do not share a sequence cursor", () => {
  const store = new EventStore(4);
  const first = { ...event(1, "first:1"), producerId: "plug::in", sessionId: "session" };
  const second = { ...event(1, "second:1"), producerId: "plug", sessionId: "in::session" };
  assert.equal(store.append(first), 1);
  assert.equal(store.append(second), 2);
  assert.equal(Object.keys(store.snapshot().state.instances).length, 2);
});

test("EventStore backlog is bounded and reports an unreplayable cursor", () => {
  const store = new EventStore(2);
  for (let i = 1; i <= 3; i++) store.append(event(i));
  assert.equal(store.backlog(0), undefined);
  assert.deepEqual(store.backlog(1)?.map((d) => d.cursor), [2, 3]);
});

test("append defers the graph clone until a subscriber reads the snapshot", () => {
  const store = new EventStore(10);
  const clone = globalThis.structuredClone;
  let graphClones = 0;
  globalThis.structuredClone = ((value: unknown, options?: unknown) => {
    if (value !== null && typeof value === "object" && "instances" in value) graphClones += 1;
    return (clone as (input: unknown, options?: unknown) => unknown)(value, options);
  }) as typeof structuredClone;
  try {
    store.subscribe(() => {});
    for (let seq = 1; seq <= 5; seq += 1) store.append(event(seq));
    assert.equal(graphClones, 0, "a subscriber that ignores the snapshot must not pay for a graph clone");

    let observed: number | undefined;
    store.subscribe((_delta, snapshot) => { observed = snapshot.state.instances["pi-persona::session"]?.contextPercent; });
    store.append(event(6));
    assert.equal(observed, 6);
    assert.equal(graphClones, 1, "the graph is cloned once, and only because a subscriber read it");
  } finally {
    globalThis.structuredClone = clone;
  }
});

test("the snapshot handed to a subscriber is a defensive copy of the graph", () => {
  const store = new EventStore(10);
  let captured: { cursor: number; state: { instances: Record<string, { contextPercent: number }> } } | undefined;
  store.subscribe((_delta, snapshot) => { captured = snapshot; });
  store.append(event(1));
  assert.equal(captured?.cursor, 1);
  captured!.state.instances["pi-persona::session"]!.contextPercent = 99;
  assert.equal(store.snapshot().state.instances["pi-persona::session"]?.contextPercent, 1);
});

test("peek exposes the live graph without cloning it", () => {
  const store = new EventStore(10);
  store.append(event(1));
  const clone = globalThis.structuredClone;
  let graphClones = 0;
  globalThis.structuredClone = ((value: unknown, options?: unknown) => {
    if (value !== null && typeof value === "object" && "instances" in value) graphClones += 1;
    return (clone as (input: unknown, options?: unknown) => unknown)(value, options);
  }) as typeof structuredClone;
  try {
    assert.equal(store.peek().instances["pi-persona::session"]?.contextPercent, 1);
    assert.equal(graphClones, 0, "peek is a read, not a copy");
  } finally {
    globalThis.structuredClone = clone;
  }
  assert.notEqual(store.peek(), store.snapshot().state, "snapshot still hands out an isolated copy");
});
