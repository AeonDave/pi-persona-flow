import type {
  AgentDescriptor,
  AgentStatus,
  InstanceDescriptor,
  InstanceStatus,
  MessageDescriptor,
  PeerDescriptor,
  TelemetryEvent,
  ToolDescriptor,
} from "../shared/protocol.ts";
import { isKnownTelemetryEvent } from "../shared/protocol.js";


export interface InstanceView extends InstanceDescriptor {
  persona: string;
  model: string;
  pid: number;
  contextPercent: number;
  exocomEnabled: boolean;
  producerId: string;
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  stoppedReason?: string;
}

export interface AgentView extends AgentDescriptor {
  key: string;
  sessionId: string;
  producerId: string;
  parentKey?: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}

export interface ToolView extends ToolDescriptor {
  key: string;
  sessionId: string;
  producerId: string;
  agentKey: string;
  startedAt: number;
  endedAt?: number;
}

export interface MessageView extends MessageDescriptor {
  key: string;
  sessionId: string;
  producerId: string;
  fromKey: string;
  toKey: string;
  ts: number;
}

export interface SequenceGap { from: number; to: number }

/**
 * Registry entry for one stream. A stream's index outlives — and can exist entirely without — an
 * instance view of it: nothing obliges a producer to emit instance.*, so the registry, not
 * `instances`, is what every per-stream map is bounded against.
 */
export interface StreamStamp {
  /** The producing plugin. Carried rather than parsed back out of the composite key, because the wire
   *  contract's id charset lets either half of one contain "::". */
  producerId: string;
  /** Local arrival ordinal: stamped when the stream appears, restamped when it becomes evictable. */
  seen: number;
}

export interface GraphState {
  instances: Record<string, InstanceView>;
  agents: Record<string, AgentView>;
  tools: Record<string, ToolView>;
  messages: MessageView[];
  peers: Record<string, PeerDescriptor>;
  events: TelemetryEvent[];
  lastSeq: Record<string, number>;
  gaps: Record<string, SequenceGap[]>;
  streams: Record<string, StreamStamp>;
  /** Monotonic source for `StreamStamp.seen`. An ordinal, never a clock. */
  streamClock: number;
}

const MAX_EVENTS = 5_000;
const MAX_MESSAGES = 1_000;
const MAX_SEQUENCE_GAPS = 128;
export const MAX_INACTIVE_STREAMS = 256;
export const MAX_TOOLS = 1_000;
export const MAX_AGENTS = 1_000;
/** A producer that never emits a terminal event must not grow a map forever either, so live work gets
 *  a hard ceiling of its own, set this multiple above the ended-history cap. */
const ENTITY_CEILING = 2;
/** Live streams and stale ones still holding work are exempt from the terminal budget, so — like
 *  agents and tools — they get a hard ceiling of their own this multiple above it. */
const STREAM_CEILING = 2;
/** Hard ceiling on every per-stream map, exemptions included. It also bounds the cost of the one map
 *  that genuinely has to be rewritten per event: `lastSeq` cannot be mutated in place, because the
 *  reducer is called from a React state updater that is invoked twice per delta under StrictMode and
 *  from a store whose snapshot clone is deferred — both need `previous` to survive the call intact. */
export const MAX_STREAMS = MAX_INACTIVE_STREAMS * STREAM_CEILING;
/** Prune below a cap rather than to it, so one sort-and-rebuild amortizes over many later events. */
const RETAIN_RATIO = 0.9;

function keySegment(value: string): string {
  // Keep ordinary ids readable while escaping the separator and its escape marker. Unlike
  // encodeURIComponent this is total for JSON strings, including lone UTF-16 surrogates.
  return value.replaceAll("%", "%25").replaceAll(":", "%3A");
}

export function entityKey(producerId: string, sessionId: string, entityId?: string): string {
  const stream = `${keySegment(producerId)}::${keySegment(sessionId)}`;
  return entityId === undefined ? stream : `${stream}::${keySegment(entityId)}`;
}

function streamKey(producerId: string, sessionId: string): string { return entityKey(producerId, sessionId); }

export function createGraphState(): GraphState {
  return {
    instances: {},
    agents: {},
    tools: {},
    messages: [],
    peers: {},
    events: [],
    lastSeq: {},
    gaps: {},
    streams: {},
    streamClock: 0,
  };
}

/**
 * Fold-tolerance for a graph that arrives without a registry — persisted, or produced by a reducer older
 * than the registry itself. Treat it as empty rather than throwing on the consumer: every stream in it
 * re-registers on its own next event, which is what a first event does for any stream anyway.
 */
function withRegistry(state: GraphState): GraphState {
  // Truthiness, not `!== undefined`: a registry that JSON-round-tripped as null is exactly the shape
  // this tolerance exists for, and the `?? {}` below already produces the right value for it.
  if (state.streams && Number.isFinite(state.streamClock)) return state;
  const streams = state.streams ?? {};
  // Restarting the ordinals underneath stamps that already exist would rank every new arrival as older
  // than every old one, so the clock resumes above the highest stamp rather than at zero.
  let streamClock = 0;
  for (const stamp of Object.values(streams)) if (stamp.seen > streamClock) streamClock = stamp.seen;
  return { ...state, streams, streamClock };
}

/**
 * Age out streams that have gone silent. Staleness is a wall-clock guess, and replay measures a
 * historical ts against it, so a live session's own log looks stale on the first pass: the guess may
 * relabel the stream, never terminalize the work under it. Only instance.stopped is authoritative.
 */
export function markStale(state: GraphState, now: number, staleAfterMs: number): GraphState {
  const previous = withRegistry(state);
  if (!Number.isFinite(now) || staleAfterMs <= 0) return previous;
  let instances = previous.instances;
  const staled: [string, string][] = [];
  for (const [key, instance] of Object.entries(previous.instances)) {
    // Liveness is a terminal denylist, not a two-word allowlist: the contract lets any producer report
    // its own status vocabulary, and a silent stream must age out whatever word it last used.
    if (!terminalStream(instance.status) && now - instance.updatedAt >= staleAfterMs) {
      if (instances === previous.instances) instances = { ...previous.instances };
      instances[key] = { ...instance, status: "stale" };
      staled.push([key, instance.producerId]);
    }
  }
  if (instances === previous.instances) return previous;
  // Going stale is one of the two edges that can make a stream evictable, so it restamps and prunes.
  return boundEntities(pruneStreams(stampStreams({ ...previous, instances }, staled)));
}

function terminalStream(status: InstanceStatus): boolean {
  return status === "stopped" || status === "stale";
}

function fallbackInstance(producerId: string, sessionId: string, ts: number): InstanceView {
  return {
    producerId,
    sessionId,
    displayName: sessionId,
    persona: "",
    model: "",
    status: "active",
    pid: 0,
    contextPercent: 0,
    exocomEnabled: false,
    startedAt: ts,
    updatedAt: ts,
  };
}

function terminal(status: AgentStatus): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

function terminalTool(status: ToolView["status"]): boolean {
  return status === "done" || status === "failed";
}

function messageEndpointKey(channel: MessageDescriptor["channel"], producerId: string, sessionId: string, endpoint: string): string {
  if (channel === "intercom") return entityKey(producerId, sessionId, endpoint);
  if (endpoint === sessionId) return streamKey(producerId, sessionId);
  if (endpoint === "*") return "";
  // The wire contract carries canonical peer session ids. Routing tokens contain only a hash
  // and cannot be reversed here; resolving them belongs at the producer's transport adapter.
  return entityKey(producerId, sessionId, endpoint);
}

/**
 * Register streams and re-rank them. Called on the two edges that can make a per-stream map grow or a
 * stream evictable — a stream's first event, and the moment it stops or goes stale — never per event:
 * the stamp map is copied here, and only rare writes keep that copy off the hot path.
 */
function stampStreams(state: GraphState, stamped: readonly (readonly [string, string])[]): GraphState {
  if (stamped.length === 0) return state;
  const streams = { ...state.streams };
  let streamClock = state.streamClock;
  for (const [key, producerId] of stamped) streams[key] = { producerId, seen: (streamClock += 1) };
  return { ...state, streams, streamClock };
}

/** A key can be present in a per-stream map and absent from the registry only in a graph folded from
 *  elsewhere. Rank it as the newest arrival, never the oldest: that is what `reduceTelemetry` does with a
 *  stream it has not seen before, its real age is unknown, and an unknown age must not be a death
 *  sentence. It is stamped for real on its stream's next event. */
function seenOf(streams: Record<string, StreamStamp>, key: string): number {
  return streams[key]?.seen ?? Number.MAX_SAFE_INTEGER;
}

/** Eviction order: newest arrival first. */
function newestStreamFirst(streams: Record<string, StreamStamp>): (left: string, right: string) => number {
  return (left, right) => seenOf(streams, right) - seenOf(streams, left);
}

/** Eviction order: oldest arrival first. */
function oldestStreamFirst(streams: Record<string, StreamStamp>): (left: string, right: string) => number {
  return (left, right) => seenOf(streams, left) - seenOf(streams, right);
}

/**
 * Split the terminal budget max-min fairly between producers: a producer that churns hundreds of short
 * sessions must not spend the share of a producer that opened one. Each keeps its newest streams up to
 * its share; shares nobody claims — and the whole budget, when there are more producers than slots —
 * fall to the newest streams overall.
 */
function fairShare(keys: readonly string[], streams: Record<string, StreamStamp>, budget: number): string[] {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const producerId = streams[key]?.producerId ?? "";
    const group = groups.get(producerId);
    if (group) group.push(key);
    else groups.set(producerId, [key]);
  }
  const newestFirst = newestStreamFirst(streams);
  const kept: string[] = [];
  let remaining = budget;
  let pending = groups.size;
  // Smallest claim first: a producer asking for less than its share leaves the rest to those asking
  // for more, which is what makes the split max-min fair rather than merely equal.
  for (const group of [...groups.values()].sort((left, right) => left.length - right.length)) {
    const quota = Math.min(group.length, Math.floor(remaining / pending));
    if (quota > 0) kept.push(...group.sort(newestFirst).slice(0, quota));
    remaining -= quota;
    pending -= 1;
  }
  if (remaining > 0) {
    const claimed = new Set(kept);
    kept.push(...keys.filter((key) => !claimed.has(key)).sort(newestFirst).slice(0, remaining));
  }
  return kept;
}

/**
 * The ceiling is the backstop the exemption must not defeat: past it streams go whatever they still hold,
 * exactly as the agent ceiling does. Which ones go is not a flat oldest-first over everything retained,
 * though — a stream is RESTAMPED when it stops, so every terminal stream carries a newer arrival ordinal
 * than the live session that has outlived it, and ranking the whole set on arrival would take the live one
 * first. So the terminal admissions go first, oldest of them first, and only what still has to come out of
 * the exempt set afterwards is ranked — split between producers, as the terminal budget already is.
 */
function evictToCeiling(kept: Set<string>, admitted: readonly string[], streams: Record<string, StreamStamp>): void {
  const target = retain(MAX_STREAMS);
  for (const key of [...admitted].sort(oldestStreamFirst(streams))) {
    if (kept.size <= target) return;
    kept.delete(key);
  }
  if (kept.size <= target) return;
  const exempt = fairShare([...kept], streams, target);
  kept.clear();
  for (const key of exempt) kept.add(key);
}

/** A peer key is `stream::peerSessionId`, and the id charset lets a session id contain "::" too, so the
 *  stream is the longest prefix the retained set knows. */
function peerStream(key: string, kept: Set<string>): string | undefined {
  for (let cut = key.lastIndexOf("::"); cut > 0; cut = key.lastIndexOf("::", cut - 1)) {
    const stream = key.slice(0, cut);
    if (kept.has(stream)) return stream;
  }
  return undefined;
}

/**
 * Bound every per-stream map together, index maps included — a producer that never emits instance.*
 * opens streams all the same, so cleanup is keyed off the stream registry rather than off `instances`.
 * Only instance.stopped is authority that a stream is finished, so a stream a wall-clock guess merely
 * relabelled "stale" keeps its place while it still holds a non-terminal agent or an unfinished tool.
 */
function pruneStreams(state: GraphState): GraphState {
  const registered = Object.keys(state.streams);
  const viewed = Object.keys(state.instances);
  // Probe the two maps before merging them: below the budget there is nothing to rank, and this runs
  // on every stream a producer opens.
  if (registered.length <= MAX_INACTIVE_STREAMS && viewed.length <= MAX_INACTIVE_STREAMS) return state;
  const keys = new Set(registered);
  for (const key of viewed) keys.add(key);

  const busy = new Set<string>();
  for (const agent of Object.values(state.agents)) if (!terminal(agent.status)) busy.add(streamKey(agent.producerId, agent.sessionId));
  for (const tool of Object.values(state.tools)) if (!terminalTool(tool.status)) busy.add(streamKey(tool.producerId, tool.sessionId));

  const kept = new Set<string>();
  const evictable: string[] = [];
  for (const key of keys) {
    const status = state.instances[key]?.status;
    const live = status !== undefined && !terminalStream(status);
    if (live || (status !== "stopped" && busy.has(key))) kept.add(key);
    else evictable.push(key);
  }
  // Rank on local arrival, never on the producer-supplied updatedAt: a producer controls its own ts and
  // could otherwise skew every other producer's streams out of the graph.
  const admitted = evictable.length > MAX_INACTIVE_STREAMS
    ? fairShare(evictable, state.streams, retain(MAX_INACTIVE_STREAMS))
    : evictable;
  for (const key of admitted) kept.add(key);
  // Past the ceiling a still-live evicted stream re-registers on its very next event and takes a slot
  // back, so membership up here churns. RETAIN_RATIO is what bounds that: a trip frees a tenth of the
  // ceiling at once, so it costs one rebuild per ~50 registrations rather than one per event, and a
  // re-registered stream is stamped newest and survives the following trip. Above this many live streams
  // no dashboard can draw them anyway, and the maps this replaced were unbounded.
  if (kept.size > MAX_STREAMS) evictToCeiling(kept, admitted, state.streams);
  if (kept.size === keys.size) return state;

  const instances: Record<string, InstanceView> = {};
  for (const [key, instance] of Object.entries(state.instances)) if (kept.has(key)) instances[key] = instance;
  const agents: Record<string, AgentView> = {};
  for (const [key, agent] of Object.entries(state.agents)) if (kept.has(streamKey(agent.producerId, agent.sessionId))) agents[key] = agent;
  const tools: Record<string, ToolView> = {};
  for (const [key, tool] of Object.entries(state.tools)) if (kept.has(streamKey(tool.producerId, tool.sessionId))) tools[key] = tool;
  const peers: Record<string, PeerDescriptor> = {};
  for (const [key, peer] of Object.entries(state.peers)) if (peerStream(key, kept) !== undefined) peers[key] = peer;
  const streams: Record<string, StreamStamp> = {};
  for (const [key, stamp] of Object.entries(state.streams)) if (kept.has(key)) streams[key] = stamp;
  const lastSeq: Record<string, number> = {};
  for (const [key, seq] of Object.entries(state.lastSeq)) if (kept.has(key)) lastSeq[key] = seq;
  const gaps: Record<string, SequenceGap[]> = {};
  for (const [key, list] of Object.entries(state.gaps)) if (kept.has(key)) gaps[key] = list;
  return { ...state, instances, agents, tools, peers, streams, lastSeq, gaps };
}

/** Keep every unfinished entity, plus the newest ended ones: one live session must not grow forever. */
function boundEntities(state: GraphState): GraphState {
  const agents = boundAgents(state.agents);
  const tools = boundTools(state.tools);
  return agents === state.agents && tools === state.tools ? state : { ...state, agents, tools };
}

/** Eviction order: an entity ages by its end when it has one, otherwise by its start. */
function recency(entity: { startedAt: number; endedAt?: number }): number {
  return entity.endedAt ?? entity.startedAt;
}

function newestFirst<T extends { startedAt: number; endedAt?: number }>(entries: [string, T][]): [string, T][] {
  return entries.sort(([, left], [, right]) => recency(right) - recency(left));
}

/** Overshoot the cap on the way down; the next entity to end then costs nothing. */
function retain(cap: number): number {
  return Math.floor(cap * RETAIN_RATIO);
}

function boundTools(tools: Record<string, ToolView>): Record<string, ToolView> {
  const entries = Object.entries(tools);
  // Terminality is a denylist, like every other liveness test here: the contract lets a producer name
  // an in-flight call with its own word, and live work must never be classified as history.
  const ended = entries.filter(([, tool]) => terminalTool(tool.status));
  if (ended.length <= MAX_TOOLS && entries.length <= MAX_TOOLS * ENTITY_CEILING) return tools;
  const dropped = new Set<string>();
  if (ended.length > MAX_TOOLS) for (const [key] of newestFirst(ended).slice(retain(MAX_TOOLS))) dropped.add(key);
  const surviving = entries.filter(([key]) => !dropped.has(key));
  // Calls that never finish can breach the ceiling on their own, so the newest survivors win.
  if (surviving.length > MAX_TOOLS * ENTITY_CEILING) {
    for (const [key] of newestFirst(surviving).slice(retain(MAX_TOOLS * ENTITY_CEILING))) dropped.add(key);
  }
  const next: Record<string, ToolView> = {};
  for (const [key, tool] of entries) if (!dropped.has(key)) next[key] = tool;
  return next;
}

/**
 * The ceiling is the backstop that ancestor exemption must not defeat: a chain where every agent names
 * the previous one exempts the whole map, so here the oldest go regardless of who points at them. Losing
 * an ancestor re-roots its children rather than detaching them — the dashboard draws a forest, and a
 * parentKey that resolves to nothing is the actual defect.
 */
function evictOldest(kept: Set<string>, agents: Record<string, AgentView>, target: number): void {
  const byAge = [...kept].sort((left, right) => recency(agents[right]!) - recency(agents[left]!));
  while (kept.size > target) {
    const key = byAge.pop();
    if (key === undefined) return;
    kept.delete(key);
  }
}

/** Re-root a survivor whose parent did not survive, so no view points at an agent that is not there. */
function reroot(agents: Record<string, AgentView>): Record<string, AgentView> {
  let next = agents;
  for (const [key, agent] of Object.entries(agents)) {
    if (agent.parentKey === undefined || agents[agent.parentKey] !== undefined) continue;
    if (next === agents) next = { ...agents };
    const { parentKey: _dropped, ...rerooted } = agent;
    next[key] = rerooted;
  }
  return next;
}

function boundAgents(agents: Record<string, AgentView>): Record<string, AgentView> {
  const entries = Object.entries(agents);
  const ended = entries.filter(([, agent]) => terminal(agent.status));
  if (ended.length <= MAX_AGENTS && entries.length <= MAX_AGENTS * ENTITY_CEILING) return agents;
  const kept = new Set(entries.filter(([, agent]) => !terminal(agent.status)).map(([key]) => key));
  if (ended.length > MAX_AGENTS) for (const [key] of newestFirst(ended).slice(0, retain(MAX_AGENTS))) kept.add(key);
  else for (const [key] of ended) kept.add(key);
  // Dropping an ancestor would detach the surviving subtree from the tree the dashboard draws, so the
  // closure runs BEFORE the ceiling: re-adding ancestors afterwards would undo the prune it just did.
  const pending = [...kept];
  while (pending.length > 0) {
    const parentKey = agents[pending.pop()!]?.parentKey;
    if (parentKey !== undefined && agents[parentKey] !== undefined && !kept.has(parentKey)) {
      kept.add(parentKey);
      pending.push(parentKey);
    }
  }
  if (kept.size > MAX_AGENTS * ENTITY_CEILING) evictOldest(kept, agents, retain(MAX_AGENTS * ENTITY_CEILING));
  const next: Record<string, AgentView> = {};
  for (const [key, agent] of entries) if (kept.has(key)) next[key] = agent;
  return reroot(next);
}

export function reduceTelemetry(state: GraphState, event: TelemetryEvent): GraphState {
  const previous = withRegistry(state);
  const producerId = event.producerId;
  const sequenceKey = streamKey(producerId, event.sessionId);
  const seen = previous.lastSeq[sequenceKey] ?? 0;
  if (event.seq <= seen) return previous;
  // A stream's first event is the only way a per-stream map can grow, and a stop is the only authority
  // that one is finished; nothing else has to touch the registry, so nothing else pays for a prune.
  let stamp = previous.streams[sequenceKey] === undefined;

  const next: GraphState = {
    ...previous,
    lastSeq: { ...previous.lastSeq, [sequenceKey]: event.seq },
    events: [...previous.events, event].slice(-MAX_EVENTS),
  };

  if (event.seq > seen + 1) {
    next.gaps = {
      ...previous.gaps,
      [sequenceKey]: [...(previous.gaps[sequenceKey] ?? []), { from: seen + 1, to: event.seq - 1 }].slice(-MAX_SEQUENCE_GAPS),
    };
  }

  if (!isKnownTelemetryEvent(event)) return settleStreams(next, sequenceKey, producerId, stamp);

  switch (event.type) {
    case "instance.started": {
      const base = fallbackInstance(producerId, event.sessionId, event.ts);
      next.instances = {
        ...previous.instances,
        [streamKey(producerId, event.sessionId)]: {
          ...base,
          ...event.payload,
          producerId,
          sessionId: event.sessionId,
          startedAt: event.ts,
          updatedAt: event.ts,
        },
      };
      break;
    }
    case "instance.updated":
    case "instance.heartbeat": {
      const current = previous.instances[streamKey(producerId, event.sessionId)] ?? fallbackInstance(producerId, event.sessionId, event.ts);
      next.instances = {
        ...previous.instances,
        [streamKey(producerId, event.sessionId)]: { ...current, ...event.payload, producerId, updatedAt: event.ts },
      };
      break;
    }
    case "instance.stopped": {
      stamp = true;
      const current = previous.instances[streamKey(producerId, event.sessionId)] ?? fallbackInstance(producerId, event.sessionId, event.ts);
      next.instances = {
        ...previous.instances,
        [streamKey(producerId, event.sessionId)]: {
          ...current,
          status: "stopped",
          stoppedReason: event.payload.reason,
          updatedAt: event.ts,
        },
      };
      const tools = { ...previous.tools };
      for (const [key, tool] of Object.entries(tools)) {
        if (tool.producerId === producerId && tool.sessionId === event.sessionId && tool.status === "running") tools[key] = { ...tool, status: "failed", endedAt: event.ts };
      }
      next.tools = tools;
      const agents = { ...previous.agents };
      for (const [key, agent] of Object.entries(agents)) {
        if (agent.producerId === producerId && agent.sessionId === event.sessionId && !terminal(agent.status)) agents[key] = { ...agent, status: "stopped", endedAt: event.ts, updatedAt: event.ts };
      }
      next.agents = agents;
      break;
    }
    case "agent.added": {
      const payload = event.payload;
      const key = entityKey(producerId, event.sessionId, payload.id);
      next.agents = {
        ...previous.agents,
        [key]: {
          ...payload,
          key,
          producerId,
          sessionId: event.sessionId,
          ...(payload.parentId ? { parentKey: entityKey(producerId, event.sessionId, payload.parentId) } : {}),
          startedAt: event.ts,
          updatedAt: event.ts,
          ...(terminal(payload.status) ? { endedAt: event.ts } : {}),
        },
      };
      break;
    }
    case "agent.updated": {
      const key = entityKey(producerId, event.sessionId, event.payload.id);
      const current = previous.agents[key];
      if (!current) break;
      const patch = event.payload.patch;
      next.agents = {
        ...previous.agents,
        [key]: {
          ...current,
          ...patch,
          ...(patch.parentId ? { parentKey: entityKey(producerId, event.sessionId, patch.parentId) } : {}),
          updatedAt: event.ts,
          // Reviving an agent retracts its end as well, or the ended-entity cap could evict work
          // that is still running.
          ...(patch.status === undefined ? {} : terminal(patch.status) ? { endedAt: event.ts } : { endedAt: undefined }),
        },
      };
      break;
    }
    case "agent.removed": {
      const key = entityKey(producerId, event.sessionId, event.payload.id);
      const current = previous.agents[key];
      if (!current) break;
      next.agents = {
        ...previous.agents,
        [key]: {
          ...current,
          status: event.payload.status ?? (current.status === "failed" ? "failed" : "done"),
          updatedAt: event.ts,
          endedAt: event.ts,
        },
      };
      break;
    }
    case "agent.cleared": {
      const agents = { ...previous.agents };
      for (const [key, agent] of Object.entries(agents)) {
        if (agent.producerId === producerId && agent.sessionId === event.sessionId && !terminal(agent.status)) {
          agents[key] = { ...agent, status: "stopped", updatedAt: event.ts, endedAt: event.ts };
        }
      }
      next.agents = agents;
      break;
    }
    case "tool.started": {
      const payload = event.payload;
      const key = entityKey(producerId, event.sessionId, payload.callId);
      next.tools = {
        ...previous.tools,
        [key]: {
          ...payload,
          key,
          producerId,
          sessionId: event.sessionId,
          agentKey: entityKey(producerId, event.sessionId, payload.agentId),
          startedAt: event.ts,
        },
      };
      break;
    }
    case "tool.finished": {
      const payload = event.payload;
      const key = entityKey(producerId, event.sessionId, payload.callId);
      const current = previous.tools[key];
      next.tools = {
        ...previous.tools,
        [key]: {
          ...(current ?? {
            ...payload,
            key,
            producerId,
            sessionId: event.sessionId,
            agentKey: entityKey(producerId, event.sessionId, payload.agentId),
            startedAt: event.ts,
          }),
          ...payload,
          endedAt: event.ts,
        },
      };
      break;
    }
    case "message.sent":
    case "message.received":
    case "message.replied": {
      const payload = event.payload;
      const key = entityKey(producerId, event.sessionId, payload.id);
      const view: MessageView = {
        ...payload,
        key,
        sessionId: event.sessionId,
        producerId,
        fromKey: messageEndpointKey(payload.channel, producerId, event.sessionId, payload.from),
        toKey: messageEndpointKey(payload.channel, producerId, event.sessionId, payload.to),
        ts: event.ts,
      };
      next.messages = [...previous.messages.filter((message) => message.key !== key), view].slice(-MAX_MESSAGES);
      break;
    }
    case "peers.snapshot": {
      const peers = { ...previous.peers };
      const prefix = `${entityKey(producerId, event.sessionId)}::`;
      for (const key of Object.keys(peers)) if (key.startsWith(prefix)) delete peers[key];
      for (const peer of event.payload.peers) peers[entityKey(producerId, event.sessionId, peer.sessionId)] = peer;
      next.peers = peers;
      break;
    }
  }

  return boundEntities(settleStreams(next, sequenceKey, producerId, stamp));
}

/** Register the stream and bound the per-stream maps — the whole cost of a stream's first event, and of
 *  the stop that ends it. Every other event leaves the registry untouched. */
function settleStreams(next: GraphState, key: string, producerId: string, stamp: boolean): GraphState {
  return stamp ? pruneStreams(stampStreams(next, [[key, producerId]])) : next;
}
