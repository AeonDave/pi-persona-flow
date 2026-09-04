import { TELEMETRY_VERSION, type TelemetryEvent } from "../shared/protocol.ts";
import { createGraphState, entityKey, markStale, reduceTelemetry, type GraphState } from "./reducer.ts";

export const DEFAULT_DELTA_LIMIT = 2_000;
export const DEFAULT_STALE_AFTER_MS = 30_000;

/**
 * Identity carried by the notices this consumer mints for itself. "~" is outside the wire's id
 * alphabet, so `parseTelemetryEvent` rejects it: no producer can ever mint an event that looks like
 * one of these, and none of these can ever be mistaken for a producer's own event.
 */
export const CONSUMER_PRODUCER_ID = "~flow";
export const STREAM_STALE_NOTICE = "stream.stale";

/** True for a delta this store minted rather than ingested. */
export function isConsumerNotice(event: TelemetryEvent): boolean {
  return event.producerId === CONSUMER_PRODUCER_ID;
}

export interface TelemetryDelta {
  cursor: number;
  event: TelemetryEvent;
}

export interface TelemetrySnapshot {
  cursor: number;
  state: GraphState;
}

/** Reading `snapshot.state` clones the whole graph on demand, so listeners touch it only if they need it. */
export type EventStoreListener = (delta: TelemetryDelta, snapshot: TelemetrySnapshot) => void;

export interface EventStoreOptions {
  maxDeltas?: number;
  maxEventIds?: number;
  staleAfterMs?: number;
  now?: () => number;
  initialState?: GraphState;
}

/** Server-local, cursor-addressable projection of the telemetry stream. */
export class EventStore {
  private state: GraphState;
  private cursorValue = 0;
  private readonly deltaLimit: number;
  private readonly eventIdLimit: number;
  private readonly deltas: TelemetryDelta[] = [];
  private readonly eventIds = new Set<string>();
  private readonly eventIdOrder: string[] = [];
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<EventStoreListener>();
  private readonly announcedStale = new Set<string>();
  private noticeCount = 0;

  constructor(options?: number | EventStoreOptions, initialState = createGraphState()) {
    const deltaLimit = typeof options === "number" ? options : options?.maxDeltas ?? DEFAULT_DELTA_LIMIT;
    if (!Number.isSafeInteger(deltaLimit) || deltaLimit < 1) throw new RangeError("maxDeltas must be positive");
    this.deltaLimit = deltaLimit;
    this.eventIdLimit = typeof options === "number" ? Math.max(deltaLimit, 10_000) : options?.maxEventIds ?? 10_000;
    if (!Number.isSafeInteger(this.eventIdLimit) || this.eventIdLimit < 1) throw new RangeError("maxEventIds must be positive");
    this.staleAfterMs = typeof options === "number" ? DEFAULT_STALE_AFTER_MS : options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = typeof options === "number" ? () => Date.now() : options?.now ?? (() => Date.now());
    this.state = structuredClone(typeof options === "object" ? options.initialState ?? initialState : initialState);
  }

  get eventIdCount(): number { return this.eventIds.size; }

  get cursor(): number {
    return this.cursorValue;
  }

  snapshot(): TelemetrySnapshot {
    this.state = markStale(this.state, this.now(), this.staleAfterMs);
    return { cursor: this.cursorValue, state: structuredClone(this.state) };
  }

  /**
   * The live graph, without the clone, for readers that only measure it — a status line that counts
   * agents must not cost a deep copy per event. The returned value is the store's own state and is
   * read-only by contract: mutating it corrupts every later snapshot. Callers that need an isolated
   * copy they can keep or edit use `snapshot()`.
   */
  peek(): Readonly<GraphState> {
    this.state = markStale(this.state, this.now(), this.staleAfterMs);
    return this.state;
  }

  /**
   * Snapshot view for subscribers. `append` runs on the extension host's event loop, so the graph
   * clone is deferred behind a getter and paid for only by a listener that actually reads it.
   */
  private lazySnapshot(): TelemetrySnapshot {
    const state = this.state;
    let cloned: GraphState | undefined;
    return {
      cursor: this.cursorValue,
      get state(): GraphState {
        cloned ??= structuredClone(state);
        return cloned;
      },
    };
  }

  replaySnapshot(): TelemetrySnapshot {
    return this.snapshot();
  }

  /** Return every delta after cursor, or undefined when replay is no longer possible. */
  backlog(afterCursor: number): TelemetryDelta[] | undefined {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || afterCursor > this.cursorValue) return undefined;
    if (this.deltas.length > 0 && afterCursor < this.deltas[0]!.cursor - 1) return undefined;
    return this.deltas.filter((delta) => delta.cursor > afterCursor);
  }

  subscribe(listener: EventStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ingest(event: TelemetryEvent): number | undefined {
    return this.append(event);
  }

  deltasSince(afterCursor: number): TelemetryDelta[] | undefined {
    return this.backlog(afterCursor);
  }

  /**
   * Age out silent streams and DELIVER the transition. `markStale` only relabels this store's own
   * copy of the graph; a client folds deltas and has no clock of its own, so a producer killed
   * without an `instance.stopped` would stay live on screen forever. Announcement is tracked per
   * stream rather than diffed against this call's own flip, because `snapshot`, `peek` and `append`
   * all relabel too — whoever gets there first, the stream is announced exactly once. Returns how
   * many streams were announced.
   */
  sweepStale(): number {
    this.state = markStale(this.state, this.now(), this.staleAfterMs);
    const instances = this.state.instances;
    // A stream that was pruned or that a producer revived is forgotten again, so a later relapse
    // into silence is announced afresh.
    for (const key of this.announcedStale) if (instances[key]?.status !== "stale") this.announcedStale.delete(key);
    let announced = 0;
    for (const [key, instance] of Object.entries(instances)) {
      if (instance.status !== "stale" || this.announcedStale.has(key)) continue;
      this.announcedStale.add(key);
      announced += 1;
    }
    // One notice for the whole sweep. Every stream it relabelled yields the SAME graph, and a consumer
    // answers a notice by re-reading that graph, so a notice per stream is that graph pushed once per
    // stream down every connection — 45 MB and a 423 ms stall for 60 streams — and tells a client
    // nothing the first frame did not.
    if (announced > 0) this.publish(this.staleNotice(announced));
    return announced;
  }

  /**
   * A consumer-minted notice: "streams aged out, the graph moved". It names no stream, because the
   * graph it points at is the answer for all of them at once — and so it cannot carry a stream the
   * sweep's own prune just dropped. It carries no producer sequence either: `seq` 0 sits below every
   * producer sequence, so a consumer that folds it anyway gets a no-op instead of a consumed sequence
   * number or a fabricated gap, and it is never reduced into the graph the producers own.
   */
  private staleNotice(streams: number): TelemetryEvent {
    this.noticeCount += 1;
    return {
      version: TELEMETRY_VERSION,
      producerId: CONSUMER_PRODUCER_ID,
      producerVersion: CONSUMER_PRODUCER_ID,
      id: `${CONSUMER_PRODUCER_ID}:stale:${this.noticeCount}`,
      seq: 0,
      ts: this.now(),
      // A notice belongs to no producer stream and no producer workspace; how many aged out is all it
      // has to say, and the graph says the rest.
      sessionId: "",
      workspaceId: "",
      type: STREAM_STALE_NOTICE,
      payload: { streams },
    } as TelemetryEvent;
  }

  /** The one path every delta takes, ingested or minted here: take a cursor, retain, fan out. A minted
   *  notice takes a slot in the bounded replay ring like any delta, so the window `backlog` can serve
   *  shortens by one per SWEEP — not by one per stream that aged out in it. */
  private publish(event: TelemetryEvent): TelemetryDelta {
    this.cursorValue += 1;
    const delta = { cursor: this.cursorValue, event };
    this.deltas.push(delta);
    if (this.deltas.length > this.deltaLimit) this.deltas.splice(0, this.deltas.length - this.deltaLimit);
    const snapshot = this.lazySnapshot();
    for (const listener of [...this.listeners]) {
      try { listener(delta, snapshot); } catch { /* subscribers cannot break ingestion */ }
    }
    return delta;
  }

  /** Apply one validated event. Duplicate event ids are ignored without consuming a cursor. */
  append(event: TelemetryEvent): number | undefined {
    const sequenceKey = entityKey(event.producerId, event.sessionId);
    if (event.seq <= (this.state.lastSeq[sequenceKey] ?? 0)) return undefined;
    const dedupeKey = `${event.producerId}\u0000${event.sessionId}\u0000${event.id}`;
    if (this.eventIds.has(dedupeKey)) return undefined;
    const safeEvent = structuredClone(event);
    if (!KNOWN_EVENT_TYPES.has(safeEvent.type)) safeEvent.payload = {};
    const nextState = reduceTelemetry(this.state, safeEvent);
    this.state = nextState;
    this.eventIds.add(dedupeKey);
    this.eventIdOrder.push(dedupeKey);
    while (this.eventIdOrder.length > this.eventIdLimit) {
      const expired = this.eventIdOrder.shift();
      if (expired !== undefined) this.eventIds.delete(expired);
    }
    this.state = markStale(this.state, this.now(), this.staleAfterMs);
    return this.publish(safeEvent).cursor;
  }
}

const KNOWN_EVENT_TYPES = new Set(["instance.started", "instance.updated", "instance.heartbeat", "instance.stopped", "agent.added", "agent.updated", "agent.removed", "agent.cleared", "tool.started", "tool.finished", "message.sent", "message.received", "message.replied", "peers.snapshot"]);
