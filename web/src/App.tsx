import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity, AlertTriangle, Bot, ChevronRight, CircleDot, Clock3, Command, Layers3, Pause, Play,
  Radio, RotateCcw, Search, Server, Sparkles, Terminal, Wifi, X,
} from "lucide-react";
import { entityKey, type AgentView, type GraphState, type MessageView, type ToolView } from "../../src/reducer";
import type { MessageChannel, MessageStatus, TelemetryEvent } from "../../shared/protocol";
import { attentionGraph, eventLabel, livePresence, liveStream, needsAttention, useDashboard, useFilteredGraph, useTimelineView, type Filters } from "./state";

export type EntityId = { type: "instance" | "agent" | "peer" | "tool"; key: string };
type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number; entity: EntityId; streamKey?: string; color: string; label: string; status: string; meta?: string; detail?: string; span?: string; contextPercent?: number };

const INSTANCE_BODY = 58;
const AGENT_BODY = 58;
const CHIP_STRIP = 24;
const MAX_CANVAS_TOOLS = 3;

type LayoutChannel = "hierarchy" | "intercom" | "exocom" | "other";
type Layout = { rects: Rect[]; links: Array<{ from: Point; to: Point; channel: LayoutChannel; active: boolean }>; width: number; height: number };

const COLORS = { cyan: "#65e8f4", magenta: "#f083d7", violet: "#a78bfa", amber: "#f7b955", green: "#6ee7a4", red: "#fb7185", muted: "#607b86" };

function statusColor(status: string): string {
  if (["failed", "stale"].includes(status)) return COLORS.red;
  if (["done", "stopped"].includes(status)) return COLORS.muted;
  if (["waiting", "queued", "idle"].includes(status)) return COLORS.amber;
  return COLORS.cyan;
}
/** The producer publishes `queued` for an open send and replaces that same id when the result lands.
 *  Anything else is history: animating `delivered` made every past exchange crawl forever. */
export function inFlightTraffic(status: MessageStatus | string): boolean {
  return status === "queued";
}

export function shouldAnimateTraffic(status: MessageStatus | string, reducedMotion: boolean): boolean {
  return inFlightTraffic(status) && !reducedMotion;
}

/** Intercom endpoints are `producer::session::agentId`; the instance card is `producer::session`.
 *  Matching only the exact key left the instance inspector empty for the traffic it owns. */
export function messagesForSelection(messages: readonly MessageView[], selected: EntityId): MessageView[] {
  return messages.filter((message) => {
    if (message.fromKey === selected.key || message.toKey === selected.key) return true;
    if (selected.type !== "instance") return false;
    if (entityKey(message.producerId, message.sessionId) === selected.key) return true;
    const nested = `${selected.key}::`;
    return message.fromKey.startsWith(nested) || message.toKey.startsWith(nested);
  }).slice(-5).reverse();
}

/** Describe traffic relative to the selected node. Instance-level intercom is an internal exchange,
 *  while an exact endpoint match has a useful inbound/outbound direction. */
export function messageRoute(message: MessageView, selected: EntityId): string {
  if (selected.type === "instance" && message.channel === "intercom") return `${message.from} → ${message.to}`;
  if (message.fromKey === selected.key && message.toKey !== selected.key) return `OUT → ${message.to}`;
  if (message.toKey === selected.key && message.fromKey !== selected.key) return `IN ← ${message.from}`;
  if (selected.type === "instance" && entityKey(message.producerId, message.sessionId) === selected.key) {
    if (message.from === message.sessionId && message.to !== message.sessionId) return `OUT → ${message.to}`;
    if (message.to === message.sessionId && message.from !== message.sessionId) return `IN ← ${message.from}`;
  }
  return `${message.from} → ${message.to}`;
}

/** Tools whose agentId never got an `agent.added` belong on the instance card — that is the
 *  main Pi, which is drawn as an instance, not as an agent, so an agentKey lookup misses it. */
export function toolOwnerKey(tool: { agentKey: string; producerId: string; sessionId: string }, agentKeys: ReadonlySet<string>): string {
  return agentKeys.has(tool.agentKey) ? tool.agentKey : entityKey(tool.producerId, tool.sessionId);
}

function liveTool(status: string): boolean {
  return status !== "done" && status !== "failed";
}

function canvasTool(status: string): boolean {
  return liveTool(status) || status === "failed";
}

function byToolRank(a: ToolView, b: ToolView): number {
  const rank = (status: string): number => liveTool(status) ? 0 : status === "failed" ? 1 : 2;
  return rank(a.status) - rank(b.status) || b.startedAt - a.startedAt || a.key.localeCompare(b.key);
}

/** Canvas chips are live work and failures only. Successful history belongs in the inspector,
 *  not as a ring of anonymous dots around a finished subagent. */
export function rankCanvasTools(tools: readonly ToolView[]): { visible: ToolView[]; hidden: number } {
  const ranked = tools.filter((tool) => canvasTool(tool.status)).sort(byToolRank);
  const visible = ranked.slice(0, MAX_CANVAS_TOOLS);
  return { visible, hidden: Math.max(0, ranked.length - visible.length) };
}

export function toolStats(tools: readonly ToolView[]): { total: number; failed: number; running: number } {
  let failed = 0, running = 0;
  for (const tool of tools) {
    if (tool.status === "failed") failed += 1;
    else if (liveTool(tool.status)) running += 1;
  }
  return { total: tools.length, failed, running };
}

/** Producer labels often already append the model (`name · glm-5.3`). The card draws the model
 *  on its own line, so repeating it in the title is what made the name look truncated. */
export function agentTitle(label: string, model?: string): string {
  const modeled = modelLabel(model);
  if (!modeled) return label;
  const suffix = ` · ${modeled}`;
  return label.endsWith(suffix) ? label.slice(0, -suffix.length).trimEnd() : label;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function summaryLine(model: string | undefined, stats: { total: number; failed: number; running: number }): string {
  const parts: string[] = [];
  const named = modelLabel(model);
  if (named) parts.push(named);
  if (stats.failed) parts.push(`${stats.failed} failed`);
  if (stats.running) parts.push(`${stats.running} live`);
  else if (!stats.failed && stats.total) parts.push(`${stats.total} tools`);
  return parts.join(" · ");
}

/** Producer status is the last stamp, not presence. Live tools mean the run is still going. */
export function displayAgentStatus(status: string, stats: { running: number }): string {
  if (stats.running > 0 && ["failed", "done", "stopped"].includes(status)) return "running";
  return status;
}

const SIBLING_GAP = 10;
const SIBLING_MIN = 128;
const SIBLING_MAX = 176;

/** Pack siblings into as many columns as `available` can hold without overlap. Shrink below the
 *  preferred min only when a single column would still overflow. */
export function siblingColumns(count: number, available: number): { cols: number; itemWidth: number } {
  const usable = Math.max(1, available);
  if (count <= 0) return { cols: 1, itemWidth: Math.min(SIBLING_MAX, usable) };
  const cols = Math.min(count, Math.max(1, Math.floor((usable + SIBLING_GAP) / (SIBLING_MIN + SIBLING_GAP))));
  const itemWidth = Math.min(SIBLING_MAX, Math.max(1, (usable - (cols - 1) * SIBLING_GAP) / cols));
  return { cols, itemWidth };
}

export function toolsForSelection(graph: GraphState, selected: EntityId): ToolView[] {
  const tools = Object.values(graph.tools);
  const agentKeys = new Set(Object.keys(graph.agents));
  const ranked = (list: ToolView[]): ToolView[] => [...list].sort((a, b) => b.startedAt - a.startedAt || a.key.localeCompare(b.key));
  if (selected.type === "tool") {
    const current = graph.tools[selected.key];
    if (!current) return [];
    return ranked(tools.filter((tool) => toolOwnerKey(tool, agentKeys) === toolOwnerKey(current, agentKeys)));
  }
  if (selected.type === "agent") return ranked(tools.filter((tool) => tool.agentKey === selected.key));
  if (selected.type === "instance") return ranked(tools.filter((tool) => toolOwnerKey(tool, agentKeys) === selected.key));
  return [];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function toolColor(status: string): string {
  if (status === "failed") return COLORS.red;
  if (liveTool(status)) return COLORS.cyan;
  return COLORS.muted;
}

function placeToolChips(owner: Rect, tools: readonly ToolView[], rects: Rect[]): void {
  const { visible, hidden } = rankCanvasTools(tools);
  if (visible.length === 0) return;
  owner.meta = hidden > 0 ? `+${hidden}` : undefined;
  const gap = 4;
  const inner = Math.max(44, owner.width - 16);
  const chipW = Math.min(110, Math.max(28, (inner - gap * (visible.length - 1)) / visible.length));
  const chipH = 16;
  const chipY = owner.y + owner.height - 5 - chipH;
  visible.forEach((tool, index) => {
    rects.push({
      x: owner.x + 8 + index * (chipW + gap), y: chipY, width: chipW, height: chipH,
      entity: { type: "tool", key: tool.key }, streamKey: owner.streamKey,
      color: toolColor(tool.status), label: tool.name, status: tool.status,
    });
  });
}

/** The instance card a peer/exocom endpoint key refers to. Both are `producer::observer::observed`
 *  (or `producer::observer` for a self-reference), and the pi being named is always the LAST segment
 *  under the producer that reported it — so a peer row and a message edge resolve to the same node. */
function cardKeyFor(key: string): string {
  const producer = key.slice(0, Math.max(0, key.indexOf("::")));
  const observed = key.slice(key.lastIndexOf("::") + 2);
  return producer && observed ? `${producer}::${observed}` : key;
}

/** The part of a model ref that identifies the MODEL: "openrouter/poolside/laguna-s-2.1:free" is
 *  mostly routing, and clipping it left ("openrouter/pool…") hides the only half a reader wants.
 *  Drop the provider path and the billing/tier suffix, exactly as pi-persona's own tree does. */
export function modelLabel(value: string | undefined): string {
  if (!value) return "";
  return value.split("/").pop()?.split(":")[0] ?? "";
}

function short(value: string | undefined, length = 22): string {
  if (!value) return "—";
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
function formatTime(ts: number): string { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function relative(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}
function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
}
function center(rect: Rect): Point { return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }


/** How many PEERS there are, not how many observations were reported. Each instance names every other
 *  in its own peers.snapshot, so a workspace of N mutually-visible pi produces N*(N-1) entries — a
 *  count of 6 for the 3 processes on screen. Distinct observed sessions is the number a reader means. */
export function distinctPeers(graph: GraphState): number {
  return new Set(Object.keys(graph.peers).map((key) => key.slice(key.lastIndexOf("::") + 2))).size;
}

export function computeLayout(graph: GraphState, width: number, height: number): Layout {
  const instances = Object.entries(graph.instances).filter(([, instance]) => liveStream(instance.status)).sort(([a], [b]) => a.localeCompare(b));
  const rects: Rect[] = [];
  const links: Layout["links"] = [];
  const pad = 24;
  const cols = Math.max(1, Math.min(2, instances.length));
  const gap = 18;
  const cardWidth = (width - pad * 2 - gap * (cols - 1)) / cols;
  let cardY = pad;
  for (let rowStart = 0; rowStart < instances.length; rowStart += cols) {
    let rowBottom = cardY + 270;
    const instanceRow = instances.slice(rowStart, rowStart + cols);
    instanceRow.forEach(([sessionId, instance], col) => {
    const cardX = pad + col * (cardWidth + gap);
    const agents = Object.values(graph.agents).filter((agent) => entityKey(agent.producerId, agent.sessionId) === sessionId);
    const agentKeySet = new Set(agents.map((agent) => agent.key));
    const toolsByOwner = new Map<string, ToolView[]>();
    for (const tool of Object.values(graph.tools)) {
      if (entityKey(tool.producerId, tool.sessionId) !== sessionId) continue;
      const owner = toolOwnerKey(tool, agentKeySet);
      const bucket = toolsByOwner.get(owner) ?? [];
      bucket.push(tool);
      toolsByOwner.set(owner, bucket);
    }
    const instanceOwned = toolsByOwner.get(sessionId) ?? [];
    const instanceChips = rankCanvasTools(instanceOwned);
    const instanceStats = toolStats(instanceOwned);
    const root: Rect = {
      x: cardX + 18, y: cardY + 54, width: cardWidth - 36,
      height: INSTANCE_BODY + (instanceChips.visible.length > 0 ? CHIP_STRIP : 0),
      entity: { type: "instance", key: sessionId }, streamKey: sessionId, color: statusColor(instance.status),
      label: instance.displayName, status: instance.status,
      span: formatElapsed(instance.updatedAt - instance.startedAt),
      detail: summaryLine(instance.model, instanceStats),
      contextPercent: instance.contextPercent,
    };
    rects.push(root);
    placeToolChips(root, instanceOwned, rects);
    const children = new Map<string | undefined, AgentView[]>();
    agents.sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key)).forEach((agent) => {
      const bucket = children.get(agent.parentKey) ?? []; bucket.push(agent); children.set(agent.parentKey, bucket);
    });
    const drawChildren = (parentKey: string | undefined, parentRect: Rect, left: number, available: number): number => {
      const childList = children.get(parentKey) ?? [];
      if (childList.length === 0) return parentRect.y + parentRect.height;
      const { cols, itemWidth } = siblingColumns(childList.length, available);
      let y = parentRect.y + parentRect.height + 25;
      let bottom = parentRect.y + parentRect.height;
      for (let offset = 0; offset < childList.length; ) {
        const inRow = Math.min(cols, childList.length - offset);
        const rowWidth = inRow * itemWidth + Math.max(0, inRow - 1) * SIBLING_GAP;
        const startX = left + (available - rowWidth) / 2;
        const row: Array<{ agent: AgentView; rect: Rect }> = [];
        for (let index = 0; index < inRow; index += 1) {
          const agent = childList[offset + index]!;
          const ownedTools = toolsByOwner.get(agent.key) ?? [];
          const chips = rankCanvasTools(ownedTools);
          const stats = toolStats(ownedTools);
          const shown = displayAgentStatus(agent.status, stats);
          const rect: Rect = {
            x: startX + index * (itemWidth + SIBLING_GAP), y, width: itemWidth,
            height: AGENT_BODY + (chips.visible.length > 0 ? CHIP_STRIP : 0),
            entity: { type: "agent", key: agent.key }, streamKey: sessionId, color: statusColor(shown),
            label: agentTitle(agent.label, agent.model), status: shown,
            span: formatElapsed((agent.endedAt ?? agent.updatedAt) - agent.startedAt),
            detail: summaryLine(agent.model, stats),
          };
          rects.push(rect);
          placeToolChips(rect, ownedTools, rects);
          links.push({ from: { x: parentRect.x + parentRect.width / 2, y: parentRect.y + parentRect.height }, to: { x: rect.x + rect.width / 2, y: rect.y }, channel: "hierarchy", active: shown === "running" && liveStream(instance.status) });
          row.push({ agent, rect });
        }
        let rowBottom = y;
        for (const { agent, rect } of row) rowBottom = Math.max(rowBottom, drawChildren(agent.key, rect, rect.x, rect.width));
        bottom = rowBottom;
        offset += inRow;
        if (offset < childList.length) y = rowBottom + 25;
      }
      return bottom;
    };
    const treeBottom = drawChildren(undefined, root, cardX + 26, cardWidth - 52);
    rowBottom = Math.max(rowBottom, treeBottom + 18);
    });
    cardY = rowBottom + gap;
  }
  // A peer entry is keyed OBSERVER::OBSERVED, so N mutually-visible instances report each other N-1
  // times over. Draw a peer only when nothing else on this canvas already IS that pi: a session with
  // its own instance card is the same process, and two observers of the same stranger are one node.
  const drawnSessions = new Set<string>();
  const peers = Object.entries(graph.peers)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([key]) => {
      const observed = key.slice(key.lastIndexOf("::") + 2);
      if (graph.instances[cardKeyFor(key)] || drawnSessions.has(observed)) return false;
      drawnSessions.add(observed);
      return true;
    });
  if (peers.length > 0) {
    const peerGap = 10;
    const peerWidth = Math.min(154, Math.max(112, (width - pad * 2 - (peers.length - 1) * peerGap) / peers.length));
    // External peers live on a right-aligned shelf. Centering a lone peer made its exocom edge cut
    // through the common odd-instance card in the lower-left column and read as a false attachment.
    const peerStart = Math.max(pad, width - pad - (peerWidth * peers.length + peerGap * (peers.length - 1)));
    const peerY = Math.max(8, height - 44);
    peers.forEach(([sessionId, peer], index) => {
      rects.push({
        x: peerStart + index * (peerWidth + peerGap), y: peerY, width: peerWidth, height: 30,
        entity: { type: "peer", key: sessionId }, color: peer.color ?? COLORS.magenta,
        label: peer.displayName, status: peer.status,
      });
    });
  }
  const points = new Map<string, Rect>();
  rects.forEach((rect) => points.set(`${rect.entity.type}:${rect.entity.key}`, rect));
  const resolve = (key: string, channel: MessageChannel): Rect | undefined => {
    if (channel === "intercom") return points.get(`agent:${key}`) ?? points.get(`instance:${key.split("::").slice(0, 2).join("::")}`);
    if (channel !== "exocom") return points.get(`agent:${key}`) ?? points.get(`instance:${key}`) ?? points.get(`peer:${key}`) ?? points.get(`instance:${key.split("::").slice(0, 2).join("::")}`);
    const targetSession = key.includes("@") ? key.slice(key.lastIndexOf("@") + 1) : key;
    const qualifiedPeer = Object.keys(graph.peers).find((id) => id.endsWith(`::${targetSession}`));
    // `instance:` before the display-name guess, and AFTER the peer lookups: a peer that is also a
    // known instance is drawn only as its card, so its edge has to land there or vanish with the node.
    return points.get(`instance:${key}`) ?? points.get(`peer:${key}`) ?? points.get(`peer:${qualifiedPeer ?? ""}`)
      ?? points.get(`instance:${cardKeyFor(key)}`)
      ?? points.get(`instance:${Object.keys(graph.instances).find((id) => graph.instances[id]?.displayName === key) ?? ""}`);
  };
  const channelLinks = new Map<string, Layout["links"][number]>();
  for (const message of graph.messages) {
    const from = resolve(message.fromKey, message.channel);
    const to = resolve(message.toKey, message.channel);
    if (!from || !to) continue;
    const channel: LayoutChannel = message.channel === "intercom" ? "intercom" : message.channel === "exocom" ? "exocom" : "other";
    const id = `${message.fromKey}\0${message.toKey}\0${channel}`;
    const active = inFlightTraffic(message.status);
    const existing = channelLinks.get(id);
    if (!existing) channelLinks.set(id, { from: center(from), to: center(to), channel, active });
    else if (active) existing.active = true;
  }
  links.push(...channelLinks.values());
  return { rects, links, width, height };
}

function GraphCanvas({ graph, selected, onSelect }: { graph: GraphState; selected?: EntityId; onSelect: (entity: EntityId) => void }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef({ pulse: 0, layout: undefined as Layout | undefined });
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const layout = useMemo(() => computeLayout(graph, size.width, size.height), [graph, size]);
  frameRef.current.layout = layout;

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const observer = new ResizeObserver(() => { const bounds = canvas.getBoundingClientRect(); setSize({ width: Math.max(500, Math.floor(bounds.width * devicePixelRatio)), height: Math.max(360, Math.floor(bounds.height * devicePixelRatio)) }); });
    observer.observe(canvas); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = (): void => setReducedMotion(media.matches);
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    let raf = 0; const draw = (): void => {
      const current = frameRef.current.layout; if (!current) return;
      const liveTraffic = current.links.some((link) => link.channel !== "hierarchy" && link.active);
      const animatedTraffic = liveTraffic && !reducedMotion;
      if (animatedTraffic) frameRef.current.pulse = (frameRef.current.pulse + 0.018) % (Math.PI * 2);
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.save();
      ctx.scale(devicePixelRatio, devicePixelRatio); const scaleX = size.width / devicePixelRatio / current.width; const scaleY = size.height / devicePixelRatio / current.height; ctx.scale(scaleX, scaleY);
      ctx.fillStyle = "#081218"; ctx.fillRect(0, 0, current.width, current.height);
      ctx.strokeStyle = "rgba(105, 168, 179, .055)"; ctx.lineWidth = 1;
      for (let x = 0; x < current.width; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, current.height); ctx.stroke(); }
      for (let y = 0; y < current.height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(current.width, y); ctx.stroke(); }
      const instances = current.rects.filter((rect) => rect.entity.type === "instance");
      instances.forEach((root) => {
        const cardX = root.x - 18; const cardY = root.y - 54; const cardW = root.width + 36;
        const owned = current.rects.filter((rect) => rect.streamKey === root.entity.key);
        const bottom = Math.max(root.y + root.height, ...owned.map((rect) => rect.y + rect.height));
        // Leaf instances do not need a reserved child row. Keeping that old empty space let the
        // bottom peer shelf sit on top of a second-row card even though neither node overlapped.
        const cardH = Math.min(current.height - cardY - 22, Math.max(root.height + 88, bottom - cardY + 18));
        ctx.fillStyle = "rgba(11, 25, 33, .92)"; ctx.strokeStyle = `${root.color}40`; ctx.lineWidth = 1; rounded(ctx, cardX, cardY, cardW, cardH, 12); ctx.fill(); ctx.stroke(); ctx.fillStyle = `${root.color}15`; rounded(ctx, cardX, cardY, cardW, 34, 12); ctx.fill();
      });
      current.links.filter((link) => link.channel === "hierarchy").forEach((link) => { ctx.strokeStyle = link.active ? "rgba(101,232,244,.45)" : "rgba(112,145,151,.25)"; ctx.lineWidth = link.active ? 1.5 : 1; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(link.from.x, link.from.y); ctx.lineTo(link.to.x, link.to.y); ctx.stroke(); ctx.setLineDash([]); });
      current.links.filter((link) => link.channel !== "hierarchy").forEach((link, index) => { const color = link.channel === "intercom" ? COLORS.cyan : link.channel === "exocom" ? COLORS.magenta : COLORS.violet; const animated = link.active && !reducedMotion; ctx.strokeStyle = `${color}${link.active ? "cc" : "60"}`; ctx.lineWidth = link.active ? 2.1 : 1.2; ctx.setLineDash(link.active ? [5, 8] : []); ctx.lineDashOffset = animated ? -frameRef.current.pulse * 30 - index * 3 : 0; ctx.beginPath(); ctx.moveTo(link.from.x, link.from.y); ctx.lineTo(link.to.x, link.to.y); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0; if (animated) { const t = (frameRef.current.pulse / (Math.PI * 2) + index * .17) % 1; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(link.from.x + (link.to.x - link.from.x) * t, link.from.y + (link.to.y - link.from.y) * t, 3, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; } });
      current.rects.forEach((rect) => {
        const isSelected = selected?.key === rect.entity.key && selected.type === rect.entity.type;
        const chip = rect.entity.type === "tool";
        ctx.fillStyle = chip ? `${rect.color}28` : "#0d2029";
        ctx.strokeStyle = isSelected ? "#f5f7f8" : `${rect.color}${chip ? "aa" : "88"}`;
        ctx.lineWidth = isSelected ? 2 : 1;
        if (chip) {
          rounded(ctx, rect.x, rect.y, rect.width, rect.height, 4); ctx.fill(); ctx.stroke();
          ctx.fillStyle = rect.color; ctx.beginPath(); ctx.arc(rect.x + 7, rect.y + rect.height / 2, 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#d5e6e8"; ctx.font = "8px ui-monospace, monospace";
          ctx.fillText(short(rect.label, Math.max(4, Math.floor((rect.width - 16) / 5))), rect.x + 12, rect.y + rect.height / 2 + 3);
          return;
        }
        rounded(ctx, rect.x, rect.y, rect.width, rect.height, 8); ctx.fill(); ctx.stroke();
        ctx.fillStyle = rect.color; ctx.beginPath(); ctx.arc(rect.x + 13, rect.y + 16, 4, 0, Math.PI * 2); ctx.fill();
        const nameRoom = rect.contextPercent !== undefined ? rect.width - 52 : rect.width - 28;
        ctx.fillStyle = "#e6f1f2"; ctx.font = `${rect.entity.type === "instance" ? "600 13px" : "500 11px"} ui-monospace, monospace`;
        ctx.fillText(short(rect.label, Math.max(10, Math.floor(nameRoom / (rect.entity.type === "instance" ? 7.2 : 6.4)))), rect.x + 24, rect.y + 20);
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillStyle = rect.color; ctx.fillText(rect.status.toUpperCase(), rect.x + 24, rect.y + 37);
        if (rect.span && rect.entity.type !== "peer") {
          const statusW = ctx.measureText(rect.status.toUpperCase()).width;
          ctx.fillStyle = "#77939a"; ctx.fillText(` · ${rect.span}`, rect.x + 24 + statusW, rect.y + 37);
        }
        if (rect.detail && rect.entity.type !== "peer") {
          ctx.fillStyle = "#8aa4aa"; ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(short(rect.detail, Math.max(12, Math.floor((rect.width - 20) / 5.4))), rect.x + 24, rect.y + 52);
        }
        if (rect.contextPercent !== undefined) {
          const ringX = rect.x + rect.width - 24; const ringY = rect.y + 29;
          ctx.strokeStyle = "#193b44"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(ringX, ringY, 10, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = rect.color; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(ringX, ringY, 10, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, rect.contextPercent) / 100) * Math.PI * 2); ctx.stroke();
          ctx.fillStyle = "#d5ecec"; ctx.font = "7px ui-monospace, monospace"; ctx.textAlign = "center";
          ctx.fillText(`${Math.round(rect.contextPercent)}%`, ringX, ringY + 3); ctx.textAlign = "start";
        }
        if (rect.meta) {
          ctx.fillStyle = "#7f9ea4"; ctx.font = "8px ui-monospace, monospace"; ctx.textAlign = "right";
          ctx.fillText(rect.meta, rect.x + rect.width - 8, rect.y + 52); ctx.textAlign = "start";
        }
      });
      instances.forEach((root) => { ctx.fillStyle = "#6c8b92"; ctx.font = "10px ui-monospace, monospace"; ctx.fillText("PI INSTANCE  /  EXOCOM", root.x - 2, root.y - 27); });
      ctx.restore(); if (animatedTraffic) raf = requestAnimationFrame(draw);
    }; raf = requestAnimationFrame(draw); return () => cancelAnimationFrame(raf);
  }, [layout, reducedMotion, selected, size]);

  return <div className="graph-canvas-shell">
    <canvas ref={canvasRef} width={size.width} height={size.height} aria-hidden="true" />
    <div className="graph-node-targets" role="group" aria-label="Live Pi instance and agent topology">
      {layout.rects.map((rect) => <button
        type="button"
        className="graph-node-target"
        key={`${rect.entity.type}:${rect.entity.key}`}
        style={{ left: `${rect.x / layout.width * 100}%`, top: `${rect.y / layout.height * 100}%`, width: `${rect.width / layout.width * 100}%`, height: `${rect.height / layout.height * 100}%` }}
        aria-label={`${rect.entity.type} ${rect.label}, ${rect.status}${rect.detail ? `, ${rect.detail}` : ""}`}
        aria-pressed={selected?.type === rect.entity.type && selected.key === rect.entity.key}
        onClick={() => onSelect(rect.entity)}
      />)}
    </div>
  </div>;
}

function StatusDot({ status }: { status: string }): ReactElement { return <span className={`status-dot status-${status}`} aria-label={status} />; }

function ToolCalls({ tools, selected, onSelect }: { tools: ToolView[]; selected?: EntityId; onSelect: (entity: EntityId) => void }): ReactElement {
  return <div className="inspector-section"><span className="eyebrow">TOOL CALLS · {tools.length}</span>{tools.length === 0 ? <div className="empty-small">No tool calls for this node.</div> : tools.slice(0, 12).map((tool) => <button type="button" key={tool.key} className={`tool-row${selected?.type === "tool" && selected.key === tool.key ? " active" : ""}`} onClick={() => onSelect({ type: "tool", key: tool.key })}><StatusDot status={tool.status} /><span>{tool.name}</span><b>{tool.status}</b><em>{tool.durationMs !== undefined ? formatDuration(tool.durationMs) : relative(tool.startedAt)}</em></button>)}</div>;
}

function Inspector({ graph, selected, onClose, onSelect }: { graph: GraphState; selected?: EntityId; onClose: () => void; onSelect: (entity: EntityId) => void }): ReactElement {
  const instance = selected?.type === "instance" ? graph.instances[selected.key] : undefined;
  const agent = selected?.type === "agent" ? graph.agents[selected.key] : undefined;
  const tool = selected?.type === "tool" ? graph.tools[selected.key] : undefined;
  const peer = selected?.type === "peer" ? graph.peers[selected.key] : undefined;
  const title = instance?.displayName ?? agent?.label ?? tool?.name ?? peer?.displayName ?? "Nothing selected";
  const relatedMessages = selected ? messagesForSelection(graph.messages, selected) : [];
  const relatedTools = selected && selected.type !== "peer" ? toolsForSelection(graph, selected) : [];
  const status = instance?.status ?? (agent ? displayAgentStatus(agent.status, toolStats(relatedTools)) : undefined) ?? tool?.status ?? peer?.status;
  const toolAgent = tool ? graph.agents[tool.agentKey] : undefined;
  const toolInstanceKey = tool ? entityKey(tool.producerId, tool.sessionId) : "";
  const last = instance ? relative(instance.updatedAt) : agent ? relative(agent.updatedAt) : tool ? relative(tool.endedAt ?? tool.startedAt) : "—";
  return <aside className="inspector" aria-label="Selected node inspector">
    <div className="inspector-head"><div><span className="eyebrow">NODE INSPECTOR</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close inspector"><X size={16} /></button></div>
    {selected ? <>
      <div className="inspector-status"><StatusDot status={status ?? "idle"} /><b>{status}</b><span className="mono">{selected.type}</span></div>
      <div className="metric-grid"><div><span>IDENTIFIER</span><b>{short(selected.key, 30)}</b></div><div><span>LAST SIGNAL</span><b>{last}</b></div></div>
      {instance && <><div className="context-meter"><div><span>CONTEXT WINDOW</span><b>{instance.contextPercent}%</b></div><div className="meter"><i style={{ width: `${Math.min(100, instance.contextPercent)}%` }} /></div></div><dl className="detail-list"><div><dt>PRODUCER</dt><dd>{instance.producerId}</dd></div><div><dt>SESSION</dt><dd title={instance.sessionId}>{short(instance.sessionId)}</dd></div><div><dt>PERSONA</dt><dd>{instance.persona || "unassigned"}</dd></div><div><dt>MODEL</dt><dd>{instance.model || "auto"}</dd></div><div><dt>DURATION</dt><dd>{formatElapsed(instance.updatedAt - instance.startedAt)}</dd></div><div><dt>PID</dt><dd>{instance.pid || "—"}</dd></div></dl></>}
      {agent && <dl className="detail-list"><div><dt>PRODUCER</dt><dd>{agent.producerId}</dd></div><div><dt>SESSION</dt><dd title={agent.sessionId}>{short(agent.sessionId)}</dd></div><div><dt>KIND</dt><dd>{agent.kind}</dd></div><div><dt>AGENT</dt><dd>{agent.agent ?? "—"}</dd></div><div><dt>PERSONA</dt><dd>{agent.persona ?? "—"}</dd></div><div><dt>MODEL</dt><dd>{modelLabel(agent.model) || "—"}</dd></div><div><dt>DURATION</dt><dd>{formatElapsed((agent.endedAt ?? agent.updatedAt) - agent.startedAt)}</dd></div><div><dt>TOOLS</dt><dd>{(() => { const stats = toolStats(relatedTools); return `${stats.total}${stats.failed ? ` · ${stats.failed} failed` : ""}${stats.running ? ` · ${stats.running} live` : ""}`; })()}</dd></div></dl>}
      {peer && <><div className="context-meter"><div><span>CONTEXT WINDOW</span><b>{peer.contextPercent}%</b></div><div className="meter"><i style={{ width: `${Math.min(100, peer.contextPercent)}%` }} /></div></div><dl className="detail-list"><div><dt>PERSONA</dt><dd>{peer.persona || "unassigned"}</dd></div><div><dt>MODEL</dt><dd>{peer.model || "auto"}</dd></div><div><dt>SENT / RX</dt><dd>{peer.sent} / {peer.received}</dd></div></dl></>}
      {tool && <dl className="detail-list">
        <div><dt>PRODUCER</dt><dd>{tool.producerId}</dd></div>
        <div><dt>SESSION</dt><dd title={tool.sessionId}>{short(tool.sessionId)}</dd></div>
        <div><dt>CALL</dt><dd>{tool.callId}</dd></div>
        <div><dt>DURATION</dt><dd>{tool.durationMs !== undefined ? formatDuration(tool.durationMs) : tool.status === "running" ? "running" : "—"}</dd></div>
        <div><dt>AGENT</dt><dd><button type="button" className="linkish" onClick={() => onSelect(toolAgent ? { type: "agent", key: tool.agentKey } : { type: "instance", key: toolInstanceKey })}>{toolAgent?.label ?? graph.instances[toolInstanceKey]?.displayName ?? tool.agentId}</button></dd></div>
      </dl>}
      {(instance || agent || tool) && <ToolCalls tools={relatedTools} selected={selected} onSelect={onSelect} />}
      <div className="inspector-section"><span className="eyebrow">RECENT TRAFFIC</span>{relatedMessages.length ? relatedMessages.map((message) => <div className="traffic-row" key={message.key}><span className={`channel-mark ${message.channel}`} /><span className="traffic-copy"><strong>{message.channel.toUpperCase()} · {message.kind}</strong><span>{messageRoute(message, selected)}</span><em>{message.size} B · {message.replyTo ? `reply to ${short(message.replyTo, 12)}` : message.expectsReply ? "reply expected" : "one-way"}</em></span><span className="traffic-state"><b>{message.status}</b><time title={new Date(message.ts).toISOString()}>{relative(message.ts)}</time></span></div>) : <div className="empty-small">No message frames for this node.</div>}</div>
    </> : <div className="empty-inspector"><CircleDot size={28} /><p>Select an instance, agent, or tool call to inspect live telemetry.</p></div>}
  </aside>;
}

function Timeline({ events, playing, cursor, onPlay, onCursor }: { events: readonly TelemetryEvent[]; playing: boolean; cursor: number | undefined; onPlay: () => void; onCursor: (value: number | undefined) => void }): ReactElement {
  const max = Math.max(1, events.length - 1);
  const live = cursor === undefined;
  const selectedCursor = live ? max : Math.max(0, Math.min(max, cursor));
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => onCursor(cursor === undefined || cursor >= max ? undefined : cursor + 1), 900);
    return () => window.clearInterval(timer);
  }, [playing, cursor, max, onCursor]);
  return <section className="timeline" aria-label="Telemetry timeline"><div className="timeline-head"><div className="timeline-title"><Clock3 size={15} /><span>EVENT STREAM</span><b>{events.length}</b></div><div className="timeline-mode"><button className={live ? "active" : ""} onClick={() => onCursor(undefined)}><Radio size={13} />LIVE</button><button className={!live ? "active" : ""} onClick={() => onCursor(cursor ?? max)}><Search size={13} />REVIEW</button></div></div><div className="timeline-track"><div className="timeline-progress" style={{ width: `${(selectedCursor / max) * 100}%` }} /><input aria-label="Replay event position" type="range" min="0" max={max} value={selectedCursor} onChange={(event) => onCursor(Number(event.target.value))} />{events.filter((_, index) => index % Math.max(1, Math.floor(events.length / 12)) === 0).map((event, index) => <span key={`${event.id}-${index}`} style={{ left: `${(events.indexOf(event) / max) * 100}%` }} className={`tick tick-${event.type.split(".")[0]}`} />)}</div><div className="timeline-foot"><button className="play-button" onClick={onPlay} aria-label={playing ? "Pause replay" : "Play replay"}>{playing ? <Pause size={14} /> : <Play size={14} />}</button><span className="mono">{live ? "NOW / FOLLOWING" : `${events[cursor ?? 0] ? formatTime(events[cursor ?? 0].ts) : "—"} / REPLAY`}</span><div className="event-pills">{events.slice(-3).reverse().map((event) => <span key={event.id}><StatusDot status="running" />{eventLabel(event.type)}</span>)}</div><button className="icon-button" onClick={() => onCursor(undefined)} aria-label="Return to live"><RotateCcw size={14} /></button></div></section>;
}

function App(): ReactElement {
  const { graph, connection, error } = useDashboard();
  const [filters, setFilters] = useState<Filters>({ instance: "", persona: "", channel: "all", attention: "all" });
  const [selected, setSelected] = useState<EntityId>(); const [inspectorOpen, setInspectorOpen] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 761px)").matches); const [playing, setPlaying] = useState(false); const [cursor, setCursor] = useState<number>();
  useEffect(() => {
    const media = window.matchMedia("(min-width: 761px)");
    const syncInspector = (): void => { if (!media.matches) setInspectorOpen(false); };
    syncInspector();
    media.addEventListener("change", syncInspector);
    return () => media.removeEventListener("change", syncInspector);
  }, []);
  const panelGraph = useDeferredValue(graph);
  const timeline = useTimelineView(panelGraph, cursor);
  const displayedGraph = timeline.graph;
  const presenceGraph = cursor === undefined ? livePresence(displayedGraph) : displayedGraph;
  const filteredGraph = useFilteredGraph(presenceGraph, filters);
  const instances = Object.entries(presenceGraph.instances); const personas = [...new Set(instances.map(([, instance]) => instance.persona).filter(Boolean))];
  const attentionCount = [...Object.values(presenceGraph.instances), ...Object.values(presenceGraph.agents)].filter(needsAttention).length;
  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]): void => setFilters((current) => ({ ...current, [key]: value }));
  const graphToShow = filters.attention === "attention" ? attentionGraph(filteredGraph) : filteredGraph;
  const runningTools = Object.values(presenceGraph.tools).filter((tool) => tool.status === "running" && liveStream(presenceGraph.instances[entityKey(tool.producerId, tool.sessionId)]?.status ?? "stale")).length;
  return <div className="app-shell"><header className="topbar"><div className="brand"><div className="brand-mark"><Command size={17} /></div><div><b>PI PERSONA FLOW</b><span>CONTROL ROOM <i>·</i> LOCAL TELEMETRY</span></div></div><div className="topbar-center"><span className="live-indicator"><i />{connection === "live" ? "LIVE" : connection.toUpperCase()}</span><span className="workspace-path"><Server size={13} />{instances.length > 0 ? "local workspace" : "waiting for workspace"}</span></div></header><main className="control-room"><aside className="rail"><div className="rail-section"><span className="eyebrow">SCOPE</span><label className="select-wrap"><Layers3 size={14} /><select value={filters.instance} onChange={(event) => updateFilter("instance", event.target.value)}><option value="">All instances · {instances.length}</option>{instances.map(([id, instance]) => <option key={id} value={id}>{instance.displayName}</option>)}</select></label><label className="select-wrap"><Sparkles size={14} /><select value={filters.persona} onChange={(event) => updateFilter("persona", event.target.value)}><option value="">All personas</option>{personas.map((persona) => <option key={persona} value={persona}>{persona}</option>)}</select></label></div><div className="rail-section"><span className="eyebrow">CHANNEL</span><div className="segmented" role="group" aria-label="Message channel filter">{(["all", "intercom", "exocom"] as const).map((channel) => <button key={channel} className={filters.channel === channel ? "active" : ""} onClick={() => updateFilter("channel", channel)}>{channel === "all" ? "ALL" : channel.toUpperCase()}</button>)}</div></div><div className="rail-section"><span className="eyebrow">ATTENTION</span><button className={`attention-toggle ${filters.attention === "attention" ? "active" : ""}`} onClick={() => updateFilter("attention", filters.attention === "all" ? "attention" : "all")}><AlertTriangle size={14} />Needs attention <b>{attentionCount}</b></button></div><div className="rail-section rail-stats"><span className="eyebrow">SYSTEM PULSE</span><div className="rail-stat"><Activity size={15} /><span>AGENTS</span><b>{Object.keys(graphToShow.agents).length}</b></div><div className="rail-stat"><Wifi size={15} /><span>EXOCOM PEERS</span><b>{distinctPeers(graphToShow)}</b></div><div className="rail-stat"><Terminal size={15} /><span>TOOLS ACTIVE</span><b>{runningTools}</b></div></div><div className="rail-legend"><span><i className="legend-dot cyan" />INTERCOM</span><span><i className="legend-dot magenta" />EXOCOM</span><span><i className="legend-line" />HIERARCHY</span></div></aside><section className="workspace"><div className="workspace-head"><div><span className="eyebrow">TOPOLOGY / {filters.attention === "attention" ? "ATTENTION VIEW" : "ALL SIGNALS"}</span><h1>Lifecycle topology</h1><p>Instances contain lifecycle graphs; semantic channels overlay directional traffic.</p></div><div className="workspace-summary"><div><span>INSTANCES</span><b>{Object.keys(graphToShow.instances).length}</b></div><div><span>EVENTS</span><b>{graph.events.length.toLocaleString()}</b></div><div className="signal-summary"><StatusDot status="running" /><span>STREAM HEALTH</span></div></div></div>{error && <div className="notice"><AlertTriangle size={14} />{error}</div>}<div className="graph-frame"><GraphCanvas graph={graphToShow} selected={selected} onSelect={(entity) => { setSelected(entity); setInspectorOpen(true); }} /><div className="graph-hint"><span><span className="keycap">CLICK</span> inspect node</span><span><span className="keycap">LIVE</span> canvas follows stream</span></div>{Object.keys(graphToShow.instances).length === 0 && Object.keys(graphToShow.peers).length === 0 && <div className="empty-graph"><Bot size={32} /><b>Awaiting Pi telemetry</b><span>Start a session to populate the control room.</span></div>}</div><Timeline events={timeline.events} playing={playing} cursor={cursor} onPlay={() => setPlaying((value) => !value)} onCursor={setCursor} /></section>{inspectorOpen && <Inspector graph={displayedGraph} selected={selected} onClose={() => setInspectorOpen(false)} onSelect={setSelected} />} {!inspectorOpen && <button className="reopen-inspector" onClick={() => setInspectorOpen(true)}><ChevronRight size={16} />INSPECTOR</button>}</main></div>;
}

export default App;
