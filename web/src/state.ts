import { useEffect, useMemo, useRef, useState } from "react";
import { parseTelemetryEvent, type TelemetryEvent } from "../../shared/protocol";
import { createGraphState, entityKey, fallbackInstance, reduceTelemetry, type AgentView, type GraphState, type InstanceView } from "../../src/reducer";

export type ConnectionState = "connecting" | "live" | "offline";
export type Attention = "all" | "attention";

export interface Filters {
  instance: string;
  persona: string;
  channel: "all" | "intercom" | "exocom";
  attention: Attention;
}

export interface DashboardState {
  graph: GraphState;
  cursor: number;
  connection: ConnectionState;
  error?: string;
}

interface SnapshotFrame { cursor: number; state: GraphState }
interface DeltaFrame { cursor: number; event: TelemetryEvent }

function snapshotFrame(value: unknown): SnapshotFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { cursor?: unknown; state?: unknown };
  if (!Number.isSafeInteger(candidate.cursor) || (candidate.cursor as number) < 0 || !candidate.state || typeof candidate.state !== "object") return undefined;
  const state = candidate.state as Partial<GraphState>;
  if (!state.instances || !state.agents || !state.tools || !Array.isArray(state.messages) || !Array.isArray(state.events)) return undefined;
  return { cursor: candidate.cursor as number, state: candidate.state as GraphState };
}

function deltaFrame(value: unknown): DeltaFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { cursor?: unknown; event?: unknown };
  const event = parseTelemetryEvent(candidate.event);
  if (!Number.isSafeInteger(candidate.cursor) || (candidate.cursor as number) < 1 || !event) return undefined;
  return { cursor: candidate.cursor as number, event };
}

function foldEvents(graph: GraphState, events: readonly TelemetryEvent[], from: number, to: number): GraphState {
  for (let index = from; index <= to; index += 1) {
    const event = events[index];
    if (event) graph = reduceTelemetry(graph, event);
  }
  return graph;
}

function timelineEnd(events: readonly TelemetryEvent[], position: number): number {
  return Math.max(-1, Math.min(events.length - 1, Math.trunc(position)));
}

function tokenFromLocation(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

function endpoint(path: string, token: string, extra = ""): string {
  const params = new URLSearchParams({ token });
  if (extra) params.set("after", extra);
  return `${path}?${params.toString()}`;
}

export function useDashboard(): DashboardState {
  const [state, setState] = useState<DashboardState>({ graph: createGraphState(), cursor: 0, connection: "connecting" });

  useEffect(() => {
    const token = tokenFromLocation();
    let source: EventSource | undefined;
    let disposed = false;

    const failFrame = (): void => setState((current) => ({ ...current, error: "Received an unreadable telemetry frame" }));
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(endpoint("/api/snapshot", token), { headers: { Accept: "application/json" } });
        // A token-gated dashboard opened by hand is the ordinary way to land here: say what to do
        // rather than a bare status code, which reads as "the dashboard is broken".
        if (response.status === 401 || response.status === 403) {
          throw new Error("Not authorized — this dashboard needs its session token. Run /dashboard in pi, or /dashboard status to copy the link.");
        }
        if (!response.ok) throw new Error(`snapshot returned ${response.status}`);
        const initial = snapshotFrame(await response.json());
        if (!initial) throw new Error("snapshot schema is incompatible");
        // Bail before opening the stream, not just before the setState: unmounting while the snapshot
        // was in flight left cleanup with `source` still undefined, stranding the connection it opened
        // a tick later — once per mount under StrictMode's double-mount.
        if (disposed) return;
        setState({ graph: initial.state, cursor: initial.cursor, connection: "connecting" });
        source = new EventSource(endpoint("/api/stream", token, String(initial.cursor)));
        source.onopen = () => setState((current) => ({ ...current, connection: "live", error: undefined }));
        source.addEventListener("telemetry", ((message: MessageEvent<string>) => {
          try {
            const delta = deltaFrame(JSON.parse(message.data));
            if (!delta) return failFrame();
            setState((current) => delta.cursor <= current.cursor ? current : {
              graph: reduceTelemetry(current.graph, delta.event), cursor: delta.cursor, connection: "live",
            });
          } catch { failFrame(); }
        }) as EventListener);
        source.addEventListener("snapshot", ((message: MessageEvent<string>) => {
          try {
            const snapshot = snapshotFrame(JSON.parse(message.data));
            if (!snapshot) return failFrame();
            setState({ graph: snapshot.state, cursor: snapshot.cursor, connection: "live" });
          } catch { failFrame(); }
        }) as EventListener);
        source.onerror = () => setState((current) => ({ ...current, connection: "offline", error: "Stream disconnected — retrying" }));
      } catch (error) {
        if (!disposed) setState((current) => ({ ...current, connection: "offline", error: error instanceof Error ? error.message : "Unable to load snapshot" }));
      }
    };

    void load();
    return () => { disposed = true; source?.close(); };
  }, []);

  return state;
}

/** The slider addresses at most this many trailing events; a cursor is a position inside that window. */
export const TIMELINE_WINDOW = 120;

export interface TimelineView {
  /** The event window the slider addresses. REVIEW holds it completely still: its length does not grow
   *  while deltas arrive, so a slider count that stops moving mid-review is the freeze, not a stale frame. */
  events: readonly TelemetryEvent[];
  /** What to render: live state in LIVE, the reconstruction at the cursor in REVIEW. */
  graph: GraphState;
}

interface ReplayCache { log: readonly TelemetryEvent[]; end: number; graph: GraphState; checkpoints: GraphState[] }

/** Events per replay checkpoint. The retained log is capped at MAX_EVENTS (5 000), so this keeps at
 *  most ~20 snapshots — and reductions are persistent, so the snapshots share almost all their
 *  structure. It bounds the worst backwards seek to one block instead of the whole log. */
const REPLAY_CHECKPOINT = 250;

/** Fold `[from, to]` onto `base`, recording a checkpoint at every block boundary it crosses. */
function foldCheckpointed(
  graph: GraphState,
  events: readonly TelemetryEvent[],
  from: number,
  to: number,
  checkpoints: GraphState[],
): GraphState {
  let index = Math.max(0, from);
  while (index <= to) {
    const stop = Math.min(to, (Math.floor(index / REPLAY_CHECKPOINT) + 1) * REPLAY_CHECKPOINT - 1);
    graph = foldEvents(graph, events, index, stop);
    index = stop + 1;
    if (index % REPLAY_CHECKPOINT === 0) checkpoints[index / REPLAY_CHECKPOINT] = graph;
  }
  return graph;
}

/** REVIEW replays the log captured when the cursor appeared, not the live one. Reading the live log would
 *  slide the reviewed moment out from under the user, and — because every accepted delta hands us a fresh
 *  log identity — would re-fold the whole window on the main thread for each event that arrives. Holding
 *  the log still also lets a forward step resume from the last position instead of starting over.
 *  An empty log is the one thing not worth freezing: a cursor taken before the first event would otherwise
 *  hold the dashboard on nothing while the stream fills. Returning to LIVE drops both the freeze and the
 *  cached reconstruction, so a review costs one refold to re-enter rather than pinning a window for good. */
export function useTimelineView(graph: GraphState, cursor: number | undefined): TimelineView {
  const frozen = useRef<readonly TelemetryEvent[] | undefined>(undefined);
  if (cursor === undefined) frozen.current = undefined;
  else if (frozen.current === undefined && graph.events.length > 0) frozen.current = graph.events;
  const log = frozen.current ?? graph.events;
  const events = useMemo(() => log.slice(-TIMELINE_WINDOW), [log]);
  const replay = useRef<ReplayCache | undefined>(undefined);
  const reviewed = useMemo(() => {
    if (cursor === undefined) { replay.current = undefined; return undefined; }
    const end = timelineEnd(log, log.length - events.length + Math.trunc(cursor));
    const cache = replay.current;
    const sameLog = cache !== undefined && cache.log === log;
    // Checkpoint 0 is the empty graph, so a backwards seek always has SOMETHING to resume from.
    const checkpoints = sameLog ? cache.checkpoints : [createGraphState()];
    // Resuming only forwards was the bug: a leftward slider drag fires one onChange per step, and each
    // one re-reduced the whole retained window synchronously during render. Seeking back now costs one
    // checkpoint block, not the entire log.
    const resumeFrom = sameLog && cache.end <= end
      ? { graph: cache.graph, from: cache.end + 1 }
      : (() => {
          const block = Math.min(Math.max(0, Math.floor(end / REPLAY_CHECKPOINT)), checkpoints.length - 1);
          return { graph: checkpoints[block]!, from: block * REPLAY_CHECKPOINT };
        })();
    const next: ReplayCache = {
      log, end, checkpoints,
      graph: foldCheckpointed(resumeFrom.graph, log, resumeFrom.from, end, checkpoints),
    };
    replay.current = next;
    return next.graph;
  }, [cursor, log, events.length]);
  return { events, graph: reviewed ?? graph };
}

/** A stopped or stale stream's children keep whatever status they last reported — the reducer will not
 *  guess a terminal state it never observed — so liveness on screen has to be read from the stream. */
export function liveStream(status: string): boolean {
  return status !== "stopped" && status !== "stale";
}

export function needsAttention(item: { status: string; contextPercent?: number }): boolean {
  return ["failed", "waiting", "stale"].includes(item.status) || (item.contextPercent ?? 0) >= 85;
}

/** Concluded subagents stay in the JSONL (REVIEW still has them). LIVE is presence: done/stopped/
 *  failed runs are history. A failed stamp is not a reason to keep a finished card on the canvas —
 *  the operator still sees those errors on the tools of any run that is actually still going. */
export function liveAgent(status: string): boolean {
  return status !== "done" && status !== "stopped" && status !== "failed";
}

function liveToolWork(status: string): boolean {
  return status !== "done" && status !== "failed";
}

/** A peer row is keyed `producer::observer::observed`. The observer stream is every prefix that
 *  already exists as a filtered instance key — the same walk the reducer uses when pruning. */
function peerObservedBy(peerKey: string, sessions: Set<string>): boolean {
  for (let cut = peerKey.lastIndexOf("::"); cut > 0; cut = peerKey.lastIndexOf("::", cut - 1)) {
    if (sessions.has(peerKey.slice(0, cut))) return true;
  }
  return false;
}

/** The instance card a peer/exocom endpoint key refers to. Both are `producer::observer::observed`
 *  (or `producer::observer` for a self-reference); the pi being named is the LAST segment. */
function instanceKeyForPeer(peerKey: string): string {
  const producer = peerKey.slice(0, Math.max(0, peerKey.indexOf("::")));
  const observed = peerKey.slice(peerKey.lastIndexOf("::") + 2);
  return producer && observed ? `${producer}::${observed}` : peerKey;
}

/** Preserve the hierarchy needed to render an alerting node while excluding unrelated branches. */
export function attentionGraph(graph: GraphState): GraphState {
  const visibleAgentKeys = new Set(
    Object.entries(graph.agents).filter(([, agent]) => needsAttention(agent)).map(([key]) => key),
  );
  const pending = [...visibleAgentKeys];
  while (pending.length > 0) {
    const parentKey = graph.agents[pending.pop()!]?.parentKey;
    if (parentKey && graph.agents[parentKey] && !visibleAgentKeys.has(parentKey)) {
      visibleAgentKeys.add(parentKey);
      pending.push(parentKey);
    }
  }

  const sessions = new Set(
    Object.entries(graph.instances).filter(([, instance]) => needsAttention(instance)).map(([key]) => key),
  );
  for (const key of visibleAgentKeys) {
    const agent = graph.agents[key]!;
    sessions.add(entityKey(agent.producerId, agent.sessionId));
  }

  const instances = Object.fromEntries(Object.entries(graph.instances).filter(([key]) => sessions.has(key)));
  const agents = Object.fromEntries(Object.entries(graph.agents).filter(([key]) => visibleAgentKeys.has(key)));
  const knownAgentKeys = new Set(Object.keys(graph.agents));
  const tools = Object.fromEntries(Object.entries(graph.tools).filter(([, tool]) => {
    const session = entityKey(tool.producerId, tool.sessionId);
    return sessions.has(session) && (visibleAgentKeys.has(tool.agentKey) || !knownAgentKeys.has(tool.agentKey));
  }));
  const peers = Object.fromEntries(Object.entries(graph.peers).filter(([key]) => peerObservedBy(key, sessions)));
  const messages = graph.messages.filter((message) => sessions.has(entityKey(message.producerId, message.sessionId)));
  return { ...graph, instances, agents, tools, peers, messages };
}

/**
 * Re-root survivors whose parent did not survive.
 *
 * `computeLayout` reaches agents only by walking DOWN from the roots, so an agent whose `parentKey`
 * no longer resolves is never visited: it, its whole subtree and its tool chips vanish from the
 * canvas while the rail still counts them, and REVIEW — which does not filter — disagrees with LIVE
 * about the same graph. The reducer calls a dangling `parentKey` "the actual defect" and repairs it
 * (`reroot` in src/reducer.ts); every view that prunes agents owes the same repair. One pass is
 * enough: a survivor's parent either survived, or it is re-rooted here and its own children still
 * point at a key that is present.
 */
function rerootOrphans(agents: Record<string, AgentView>): Record<string, AgentView> {
  let repaired: Record<string, AgentView> | undefined;
  for (const [key, agent] of Object.entries(agents)) {
    if (agent.parentKey === undefined || agents[agent.parentKey]) continue;
    repaired ??= { ...agents };
    const { parentKey: _orphaned, ...rest } = agent;
    repaired[key] = rest as AgentView;
  }
  return repaired ?? agents;
}

/**
 * LIVE canvas: a closed Pi stays in the JSONL log (REVIEW can still scrub it) but it is not
 * presence. Without this, every prior `--exocom` session in the workspace reappears as a card.
 */
export function livePresence(graph: GraphState): GraphState {
  const described = Object.entries(graph.instances).filter(([, instance]) => liveStream(instance.status));
  // Nothing in the contract obliges a producer to emit instance.* — the reducer bounds its per-stream
  // maps against its own registry for exactly that reason — but every card on the canvas is drawn from
  // `instances`. A stream that reports agents or tool calls without ever describing itself used to be
  // filtered out here and land on "Awaiting Pi telemetry": a blank canvas rather than a degraded one.
  // Give it the same minimal card the reducer mints when an event names a stream it has not seen.
  const instanceEntries = [...described, ...undescribedStreams(graph)];
  const sessions = new Set(instanceEntries.map(([sessionId]) => sessionId));
  const roster = Object.fromEntries(Object.entries(graph.agents).filter(([, agent]) => sessions.has(entityKey(agent.producerId, agent.sessionId))));
  const liveToolOwners = new Set<string>();
  for (const tool of Object.values(graph.tools)) {
    if (sessions.has(entityKey(tool.producerId, tool.sessionId)) && liveToolWork(tool.status)) liveToolOwners.add(tool.agentKey);
  }
  const agents = Object.fromEntries(Object.entries(roster).filter(([, agent]) => liveAgent(agent.status) || liveToolOwners.has(agent.key)));
  const liveAgentKeys = new Set(Object.keys(agents));
  const rosterKeys = new Set(Object.keys(roster));
  const tools = Object.fromEntries(Object.entries(graph.tools).filter(([, tool]) => {
    if (!sessions.has(entityKey(tool.producerId, tool.sessionId))) return false;
    if (liveAgentKeys.has(tool.agentKey)) return true;
    return !rosterKeys.has(tool.agentKey);
  }));
  const peers = Object.fromEntries(Object.entries(graph.peers).filter(([key]) => {
    if (!peerObservedBy(key, sessions)) return false;
    const known = graph.instances[instanceKeyForPeer(key)];
    return !known || liveStream(known.status);
  }));
  const messages = graph.messages.filter((message) => sessions.has(entityKey(message.producerId, message.sessionId)));
  return { ...graph, instances: Object.fromEntries(instanceEntries), agents: rerootOrphans(agents), tools, peers, messages };
}

/** Streams the graph has work for but no instance view of, as the entries `instances` is missing. */
function undescribedStreams(graph: GraphState): Array<[string, InstanceView]> {
  const minted = new Map<string, InstanceView>();
  const consider = (producerId: string, sessionId: string, ts: number): void => {
    const key = entityKey(producerId, sessionId);
    if (graph.instances[key] || minted.has(key)) return;
    minted.set(key, fallbackInstance(producerId, sessionId, ts));
  };
  for (const agent of Object.values(graph.agents)) consider(agent.producerId, agent.sessionId, agent.startedAt);
  for (const tool of Object.values(graph.tools)) consider(tool.producerId, tool.sessionId, tool.startedAt);
  return [...minted];
}

/** Instance/persona/channel scope for the canvas. Exocom is not a workspace-wide leak: a message
 *  belongs to the stream that published it, same as intercom. Peers follow their observer. */
export function filterGraph(graph: GraphState, filters: Filters): GraphState {
  const instanceEntries = Object.entries(graph.instances).filter(([sessionId, instance]) =>
    (!filters.instance || sessionId === filters.instance) && (!filters.persona || instance.persona === filters.persona));
  const sessions = new Set(instanceEntries.map(([sessionId]) => sessionId));
  const agents = Object.fromEntries(Object.entries(graph.agents).filter(([, agent]) => sessions.has(entityKey(agent.producerId, agent.sessionId))));
  const tools = Object.fromEntries(Object.entries(graph.tools).filter(([, tool]) => sessions.has(entityKey(tool.producerId, tool.sessionId))));
  const peers = Object.fromEntries(Object.entries(graph.peers).filter(([key]) => peerObservedBy(key, sessions)));
  const messages = graph.messages.filter((message) => {
    if (filters.channel !== "all" && message.channel !== filters.channel) return false;
    return sessions.has(entityKey(message.producerId, message.sessionId));
  });
  return { ...graph, instances: Object.fromEntries(instanceEntries), agents: rerootOrphans(agents), tools, peers, messages };
}

/**
 * Drop a scope selection whose option is no longer on offer.
 *
 * A controlled `<select>` with no matching option displays row 0 — "All instances" — while the filter
 * still holds the key of the instance that went away. `filterGraph` then matches nothing: an empty
 * canvas the user cannot clear, because re-picking the row the browser already shows fires no change
 * event. Reconciling the state with the list is what the user is already looking at.
 */
export function reconcileFilters(filters: Filters, instances: Record<string, unknown>, personas: readonly string[]): Filters {
  const staleInstance = filters.instance !== "" && instances[filters.instance] === undefined;
  const stalePersona = filters.persona !== "" && !personas.includes(filters.persona);
  if (!staleInstance && !stalePersona) return filters;
  return { ...filters, instance: staleInstance ? "" : filters.instance, persona: stalePersona ? "" : filters.persona };
}

export function useFilteredGraph(graph: GraphState, filters: Filters): GraphState {
  return useMemo(() => filterGraph(graph, filters), [graph, filters]);
}

export function eventLabel(type: string): string {
  return type.replace(".", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
