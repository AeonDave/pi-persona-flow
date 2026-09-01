import { test } from "node:test";
import assert from "node:assert/strict";

import { CONSUMER_PRODUCER_ID, EventStore, type TelemetryDelta } from "../src/event-store.ts";
import { MAX_INACTIVE_STREAMS } from "../src/reducer.ts";
import { parseTelemetryEvent, TELEMETRY_VERSION, type TelemetryEvent } from "../shared/protocol.ts";

function event(producerId: string, seq = 1): TelemetryEvent {
  return {
    version: TELEMETRY_VERSION,
    producerId,
    producerVersion: "1.0.0",
    id: `${producerId}:session:${seq}`,
    seq,
    ts: seq,
    sessionId: "session",
    workspaceId: "0123456789abcdef01234567",
    type: "instance.heartbeat",
    payload: { contextPercent: producerId === "a" ? 10 : 20 },
  } as TelemetryEvent;
}

test("EventStore keeps same-session sequence streams separate by producer", () => {
  const store = new EventStore(10);
  assert.equal(store.append(event("a")), 1);
  assert.equal(store.append(event("b")), 2);
  assert.equal(store.snapshot().state.lastSeq["a::session"], 1);
  assert.equal(store.snapshot().state.lastSeq["b::session"], 1);
  assert.equal(store.snapshot().state.events.length, 2);
});

test("EventStore bounds duplicate tracking with retained deltas", () => {
  const store = new EventStore({ maxDeltas: 2, maxEventIds: 2 });
  store.append(event("a", 1));
  store.append(event("a", 2));
  store.append(event("a", 3));
  assert.equal(store.eventIdCount, 2);
  assert.equal(store.append(event("a", 1)), undefined);
});

test("EventStore marks a producer stale after heartbeat silence", () => {
  let now = 100;
  const store = new EventStore({ staleAfterMs: 50, now: () => now });
  store.append({ ...event("a"), type: "instance.started", payload: { displayName: "a", persona: "", model: "", status: "active", pid: 1, contextPercent: 0, exocomEnabled: false } } as TelemetryEvent);
  now = 151;
  assert.equal(store.snapshot().state.instances["a::session"]?.status, "stale");
});

/** A live stream: `ts` is read as the last sign of life, so it has to sit inside the stale window. */
function started(producerId: string, ts: number, sessionId = "session"): TelemetryEvent {
  return {
    ...event(producerId, 1),
    id: `${producerId}:${sessionId}:1`,
    sessionId,
    ts,
    type: "instance.started",
    payload: { displayName: producerId, persona: "", model: "", status: "active", pid: 1, contextPercent: 0, exocomEnabled: false },
  } as TelemetryEvent;
}

test("an aged-out stream is announced once, as a notice no producer could have sent", () => {
  let now = 1_000;
  const store = new EventStore({ staleAfterMs: 50, now: () => now });
  assert.equal(store.append(started("a", now)), 1);
  const seen: TelemetryDelta[] = [];
  store.subscribe((delta) => seen.push(delta));

  assert.equal(store.sweepStale(), 0, "a stream still inside its window is not announced");
  now = 1_051;
  assert.equal(store.sweepStale(), 1);
  assert.equal(store.sweepStale(), 0, "a stream already stale must not re-announce on every tick");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.cursor, 2, "the notice travels the cursor path an ingested event travels");
  assert.equal(seen[0]!.event.producerId, CONSUMER_PRODUCER_ID);
  assert.equal(seen[0]!.event.seq, 0, "a notice consumes no producer sequence number");
  assert.equal(parseTelemetryEvent(seen[0]!.event), undefined, "a notice must never parse as a producer event");

  const state = store.snapshot().state;
  assert.equal(state.instances["a::session"]?.status, "stale");
  assert.equal(state.lastSeq["a::session"], 1, "the notice must not advance the producer's sequence");
  assert.equal(state.gaps["a::session"], undefined, "the notice must not manufacture a gap");
  assert.equal(state.events.length, 1, "a consumer notice never enters the graph the producers own");
  assert.deepEqual(store.backlog(1)?.map((delta) => delta.cursor), [2], "a reconnecting client replays it like any delta");

  // The sequence the notice did not take is still free for the producer that owns it.
  assert.equal(store.append({ ...event("a", 2), ts: now }), 3);
  assert.equal(store.snapshot().state.lastSeq["a::session"], 2);
});

/**
 * Every stream a single sweep ages out yields the SAME graph, and a consumer answers a notice by
 * re-reading that graph, so one notice per stream is one byte-identical full-graph frame per stream on
 * every connected client. The sweep announces itself once, however many streams it relabelled.
 */
test("one sweep mints one notice however many streams aged out", () => {
  let now = 1_000;
  const store = new EventStore({ staleAfterMs: 50, now: () => now });
  for (let index = 0; index < 40; index += 1) store.append(started("p", now, `session-${index}`));
  const seen: TelemetryDelta[] = [];
  store.subscribe((delta) => seen.push(delta));

  now = 1_051;
  assert.equal(store.sweepStale(), 40, "the count still reports every stream that aged out");
  assert.equal(seen.length, 1, "40 streams cost the graph one delta, not 40 copies of it");
  assert.equal(store.sweepStale(), 0, "a second tick re-announces nothing");
  assert.equal(seen.length, 1);
});

test("a stream pruned by the sweep is not announced back to life", () => {
  let now = 1_000;
  const store = new EventStore({ staleAfterMs: 50, now: () => now });
  const created = MAX_INACTIVE_STREAMS + 20;
  for (let index = 0; index < created; index += 1) store.append(started("p", now, `session-${index}`));
  const seen: TelemetryDelta[] = [];
  store.subscribe((delta) => seen.push(delta));

  now = 1_051;
  const announced = store.sweepStale();
  const surviving = new Set(Object.keys(store.snapshot().state.instances));
  assert.ok(surviving.size < created, `the sweep still prunes terminal streams past the cap (${surviving.size}/${created})`);
  assert.equal(announced, surviving.size, "only a stream that survived the prune is announced");
  assert.equal(seen.length, 1, "the whole sweep travels as one notice");
  // A coalesced notice names no stream, so it cannot carry a pruned one back: what a consumer re-reads
  // is the pruned graph, and the oldest stream is not in it.
  assert.equal(seen[0]!.event.sessionId, "");
  assert.ok(!surviving.has("p::session-0"), "the oldest stream was pruned, and nothing announced it back");
});

test("a stream that comes back and falls silent again is announced again", () => {
  let now = 1_000;
  const store = new EventStore({ staleAfterMs: 50, now: () => now });
  store.append(started("a", now));
  now = 1_051;
  assert.equal(store.sweepStale(), 1);

  now = 2_000;
  store.append({ ...event("a", 2), ts: now, type: "instance.updated", payload: { status: "active" } } as TelemetryEvent);
  assert.equal(store.sweepStale(), 0, "a revived stream is live again, not announced");
  now = 2_051;
  assert.equal(store.sweepStale(), 1, "silence after a revival is announced afresh");
});

test("a flip an earlier read already made is still announced by the sweep", () => {
  let now = 1_000;
  const store = new EventStore({ staleAfterMs: 50, now: () => now });
  store.append(started("a", now));
  const seen: TelemetryDelta[] = [];
  store.subscribe((delta) => seen.push(delta));

  now = 1_051;
  // Every read relabels: a status line calling peek, or a browser loading /api/snapshot, can reach
  // the stream before the sweep does, and the clients already connected must still be told.
  assert.equal(store.snapshot().state.instances["a::session"]?.status, "stale");
  assert.equal(store.sweepStale(), 1, "the sweep must announce a stream an earlier read relabelled");
  assert.equal(seen.length, 1);
});
