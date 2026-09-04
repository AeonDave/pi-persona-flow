import { useEffect, useMemo, useRef, useState } from "react";
import { parseTelemetryEvent, type TelemetryEvent } from "../../shared/protocol";
import { createGraphState, entityKey, reduceTelemetry, type GraphState } from "../../src/reducer";

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

interface ReplayCache { log: readonly TelemetryEvent[]; end: number; graph: GraphState }

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
    const resumable = cache !== undefined && cache.log === log && cache.end <= end;
    const next: ReplayCache = {
      log, end,
      graph: resumable ? foldEvents(cache.graph, log, cache.end + 1, end) : foldEvents(createGraphState(), log, 0, end),
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
 * LIVE canvas: a closed Pi stays in the JSONL log (REVIEW can still scrub it) but it is not
 * presence. Without this, every prior `--exocom` session in the workspace reappears as a card.
 */
export function livePresence(graph: GraphState): GraphState {
  const instanceEntries = Object.entries(graph.instances).filter(([, instance]) => liveStream(instance.status));
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
  return { ...graph, instances: Object.fromEntries(instanceEntries), agents, tools, peers, messages };
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
  return { ...graph, instances: Object.fromEntries(instanceEntries), agents, tools, peers, messages };
}

export function useFilteredGraph(graph: GraphState, filters: Filters): GraphState {
  return useMemo(() => filterGraph(graph, filters), [graph, filters]);
}

export function eventLabel(type: string): string {
  return type.replace(".", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
