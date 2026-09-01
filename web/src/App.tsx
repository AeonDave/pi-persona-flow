import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceSimulation, forceX } from "d3-force";
import type { MouseEvent, ReactElement } from "react";
import {
  Activity, AlertTriangle, Bot, ChevronRight, CircleDot, Clock3, Command, Layers3, Pause, Play,
  Radio, RotateCcw, Search, Server, Sparkles, Terminal, Wifi, X,
} from "lucide-react";
import type { AgentView, GraphState, MessageView } from "../../src/reducer";
import type { MessageChannel, MessageStatus, TelemetryEvent } from "../../shared/protocol";
import { eventLabel, useDashboard, useFilteredGraph, useTimelineView, type Filters } from "./state";

export type EntityId = { type: "instance" | "agent" | "peer" | "tool"; key: string };
type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number; entity: EntityId; color: string; label: string; status: string };

type LayoutChannel = "hierarchy" | "intercom" | "exocom" | "other";
type Layout = { rects: Rect[]; links: Array<{ from: Point; to: Point; channel: LayoutChannel; active: boolean }>; width: number; height: number };

const COLORS = { cyan: "#65e8f4", magenta: "#f083d7", violet: "#a78bfa", amber: "#f7b955", green: "#6ee7a4", red: "#fb7185", muted: "#607b86" };

/** A stopped or stale stream's children keep whatever status they last reported — the reducer will not
 *  guess a terminal state it never observed — so liveness on screen has to be read from the stream. */
function liveStream(status: string): boolean {
  return status !== "stopped" && status !== "stale";
}

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

/** Intercom endpoints are `producer::session::agentId`; the instance card is `producer::session`.
 *  Matching only the exact key left the instance inspector empty for the traffic it owns. */
export function messagesForSelection(messages: readonly MessageView[], selected: EntityId): MessageView[] {
  return messages.filter((message) => {
    if (message.fromKey === selected.key || message.toKey === selected.key) return true;
    if (selected.type !== "instance") return false;
    if (`${message.producerId}::${message.sessionId}` === selected.key) return true;
    const nested = `${selected.key}::`;
    return message.fromKey.startsWith(nested) || message.toKey.startsWith(nested);
  }).slice(-5).reverse();
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
function isAttention(item: { status: string; contextPercent?: number }): boolean {
  return ["failed", "waiting", "stale"].includes(item.status) || (item.contextPercent ?? 0) >= 85;
}
function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
}
function center(rect: Rect): Point { return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }

/** A small deterministic relaxation keeps siblings legible without letting them drift between frames. */
function relaxedSiblingXs(count: number, startX: number, itemWidth: number, targetX: number): number[] {
  const nodes = Array.from({ length: count }, (_, index) => ({ x: startX + itemWidth / 2 + index * (itemWidth + 10), y: 0 }));
  const simulation = forceSimulation(nodes).randomSource(() => 0.5).force("x", forceX(targetX).strength(0.08)).force("collide", forceCollide(itemWidth / 2 + 5)).stop();
  for (let tick = 0; tick < 16; tick += 1) simulation.tick();
  return nodes.map((node) => Math.max(startX, Math.min(startX + count * itemWidth + (count - 1) * 10 - itemWidth, node.x - itemWidth / 2)));
}

/** How many PEERS there are, not how many observations were reported. Each instance names every other
 *  in its own peers.snapshot, so a workspace of N mutually-visible pi produces N*(N-1) entries — a
 *  count of 6 for the 3 processes on screen. Distinct observed sessions is the number a reader means. */
export function distinctPeers(graph: GraphState): number {
  return new Set(Object.keys(graph.peers).map((key) => key.slice(key.lastIndexOf("::") + 2))).size;
}

export function computeLayout(graph: GraphState, width: number, height: number): Layout {
  const instances = Object.entries(graph.instances).sort(([a], [b]) => a.localeCompare(b));
  const rects: Rect[] = [];
  const links: Layout["links"] = [];
  const pad = 24;
  const cols = Math.max(1, Math.min(2, instances.length));
  const gap = 18;
  const cardWidth = (width - pad * 2 - gap * (cols - 1)) / cols;
  const rows = Math.max(1, Math.ceil(instances.length / cols));
  const cardHeight = Math.max(270, (height - pad * 2 - gap * (rows - 1)) / rows);

  instances.forEach(([sessionId, instance], index) => {
    const col = index % cols; const row = Math.floor(index / cols);
    const cardX = pad + col * (cardWidth + gap); const cardY = pad + row * (cardHeight + gap);
    const color = instance.color ?? (index % 2 ? COLORS.magenta : COLORS.cyan);
    const root: Rect = { x: cardX + 18, y: cardY + 54, width: cardWidth - 36, height: 58, entity: { type: "instance", key: sessionId }, color, label: instance.displayName, status: instance.status };
    rects.push(root);
    const agents = Object.values(graph.agents).filter((agent) => `${agent.producerId}::${agent.sessionId}` === sessionId);
    const children = new Map<string | undefined, AgentView[]>();
    agents.sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key)).forEach((agent) => {
      const bucket = children.get(agent.parentKey) ?? []; bucket.push(agent); children.set(agent.parentKey, bucket);
    });
    const agentRects = new Map<string, Rect>();
    const drawChildren = (parentKey: string | undefined, parentRect: Rect, depth: number): void => {
      const childList = children.get(parentKey) ?? [];
      const available = cardWidth - 52;
      const itemWidth = Math.min(154, Math.max(112, (available - (childList.length - 1) * 10) / Math.max(1, childList.length)));
      const startX = cardX + (cardWidth - (itemWidth * childList.length + Math.max(0, childList.length - 1) * 10)) / 2;
      const siblingXs = relaxedSiblingXs(childList.length, startX, itemWidth, cardX + cardWidth / 2);
      childList.forEach((agent, childIndex) => {
        const y = cardY + 137 + depth * 70;
        const rect: Rect = { x: siblingXs[childIndex] ?? startX, y, width: itemWidth, height: 48, entity: { type: "agent", key: agent.key }, color: statusColor(agent.status), label: agent.label, status: agent.status };
        rects.push(rect); agentRects.set(agent.key, rect);
        links.push({ from: { x: parentRect.x + parentRect.width / 2, y: parentRect.y + parentRect.height }, to: { x: rect.x + rect.width / 2, y: rect.y }, channel: "hierarchy", active: agent.status === "running" && liveStream(instance.status) });
        drawChildren(agent.key, rect, depth + 1);
      });
    };
    drawChildren(undefined, root, 0);
    const tools = Object.values(graph.tools).filter((tool) => `${tool.producerId}::${tool.sessionId}` === sessionId && agentRects.has(tool.agentKey));
    tools.forEach((tool, toolIndex) => {
      const owner = agentRects.get(tool.agentKey)!;
      const angle = -Math.PI / 2 + toolIndex * 0.72;
      const point = { x: owner.x + owner.width / 2 + Math.cos(angle) * 34, y: owner.y + owner.height / 2 + Math.sin(angle) * 34 };
      rects.push({ x: point.x - 7, y: point.y - 7, width: 14, height: 14, entity: { type: "tool", key: tool.key }, color: tool.status === "failed" ? COLORS.red : COLORS.violet, label: tool.name, status: tool.status });
    });
  });
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
    const peerStart = Math.max(pad, (width - (peerWidth * peers.length + peerGap * (peers.length - 1))) / 2);
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
  const layout = useMemo(() => computeLayout(graph, size.width, size.height), [graph, size]);
  frameRef.current.layout = layout;

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const observer = new ResizeObserver(() => { const bounds = canvas.getBoundingClientRect(); setSize({ width: Math.max(500, Math.floor(bounds.width * devicePixelRatio)), height: Math.max(360, Math.floor(bounds.height * devicePixelRatio)) }); });
    observer.observe(canvas); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    let raf = 0; const draw = (): void => {
      const current = frameRef.current.layout; if (!current) return;
      const liveTraffic = current.links.some((link) => link.channel !== "hierarchy" && link.active);
      if (liveTraffic) frameRef.current.pulse = (frameRef.current.pulse + 0.018) % (Math.PI * 2);
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.save();
      ctx.scale(devicePixelRatio, devicePixelRatio); const scaleX = size.width / devicePixelRatio / current.width; const scaleY = size.height / devicePixelRatio / current.height; ctx.scale(scaleX, scaleY);
      ctx.fillStyle = "#081218"; ctx.fillRect(0, 0, current.width, current.height);
      ctx.strokeStyle = "rgba(105, 168, 179, .055)"; ctx.lineWidth = 1;
      for (let x = 0; x < current.width; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, current.height); ctx.stroke(); }
      for (let y = 0; y < current.height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(current.width, y); ctx.stroke(); }
      const instances = current.rects.filter((rect) => rect.entity.type === "instance");
      instances.forEach((root) => { const cardX = root.x - 18; const cardY = root.y - 54; const cardW = root.width + 36; const cardH = Math.min(current.height - cardY - 22, root.height + 178); ctx.fillStyle = "rgba(11, 25, 33, .92)"; ctx.strokeStyle = `${root.color}40`; ctx.lineWidth = 1; rounded(ctx, cardX, cardY, cardW, cardH, 12); ctx.fill(); ctx.stroke(); ctx.fillStyle = `${root.color}15`; rounded(ctx, cardX, cardY, cardW, 34, 12); ctx.fill(); });
      current.links.filter((link) => link.channel === "hierarchy").forEach((link) => { ctx.strokeStyle = link.active ? "rgba(101,232,244,.45)" : "rgba(112,145,151,.25)"; ctx.lineWidth = link.active ? 1.5 : 1; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(link.from.x, link.from.y); ctx.lineTo(link.to.x, link.to.y); ctx.stroke(); ctx.setLineDash([]); });
      current.links.filter((link) => link.channel !== "hierarchy").forEach((link, index) => { const color = link.channel === "intercom" ? COLORS.cyan : link.channel === "exocom" ? COLORS.magenta : COLORS.violet; ctx.strokeStyle = `${color}${link.active ? "cc" : "60"}`; ctx.lineWidth = link.active ? 2.1 : 1.2; ctx.setLineDash(link.active ? [5, 8] : []); ctx.lineDashOffset = link.active ? -frameRef.current.pulse * 30 - index * 3 : 0; ctx.beginPath(); ctx.moveTo(link.from.x, link.from.y); ctx.lineTo(link.to.x, link.to.y); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0; if (link.active) { const t = (frameRef.current.pulse / (Math.PI * 2) + index * .17) % 1; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(link.from.x + (link.to.x - link.from.x) * t, link.from.y + (link.to.y - link.from.y) * t, 3, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; } });
      current.rects.forEach((rect) => { const isSelected = selected?.key === rect.entity.key && selected.type === rect.entity.type; const satellite = rect.entity.type === "tool"; ctx.fillStyle = satellite ? `${rect.color}30` : "#0d2029"; ctx.strokeStyle = isSelected ? "#f5f7f8" : `${rect.color}${satellite ? "bb" : "88"}`; ctx.lineWidth = isSelected ? 2 : 1; if (satellite) { ctx.beginPath(); ctx.arc(rect.x + 7, rect.y + 7, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); return; } rounded(ctx, rect.x, rect.y, rect.width, rect.height, 8); ctx.fill(); ctx.stroke(); ctx.fillStyle = rect.color; ctx.beginPath(); ctx.arc(rect.x + 13, rect.y + 16, 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#e6f1f2"; ctx.font = `${rect.entity.type === "instance" ? "600 13px" : "500 11px"} ui-monospace, monospace`; ctx.fillText(short(rect.label, rect.entity.type === "instance" ? 38 : 20), rect.x + 24, rect.y + 20); ctx.fillStyle = "#77939a"; ctx.font = "10px ui-monospace, monospace"; ctx.fillText(rect.status.toUpperCase(), rect.x + 24, rect.y + 37); if (rect.entity.type === "instance") { const instance = graph.instances[rect.entity.key]; if (instance) { ctx.fillStyle = "#57747c"; ctx.font = "9px ui-monospace, monospace"; const meta = `${short(instance.persona, 13)}  ·  ${modelLabel(instance.model)}`; ctx.fillText(short(meta, Math.max(16, Math.floor((rect.width - 34) / 5.4))), rect.x + 24, rect.y + 52); const ringX = rect.x + rect.width - 24; const ringY = rect.y + 29; ctx.strokeStyle = "#193b44"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(ringX, ringY, 9, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = rect.color; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(ringX, ringY, 9, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, instance.contextPercent) / 100) * Math.PI * 2); ctx.stroke(); ctx.fillStyle = "#b9d4d5"; ctx.font = "8px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.fillText(`${Math.round(instance.contextPercent)}`, ringX, ringY + 3); ctx.textAlign = "start"; } } });
      instances.forEach((root) => { ctx.fillStyle = "#6c8b92"; ctx.font = "10px ui-monospace, monospace"; ctx.fillText("PI INSTANCE  /  EXOCOM", root.x - 2, root.y - 27); });
      ctx.restore(); if (liveTraffic) raf = requestAnimationFrame(draw);
    }; raf = requestAnimationFrame(draw); return () => cancelAnimationFrame(raf);
  }, [layout, selected, size]);

  const hit = useCallback((event: MouseEvent<HTMLCanvasElement>) => { const canvas = canvasRef.current; const current = frameRef.current.layout; if (!canvas || !current) return; const bounds = canvas.getBoundingClientRect(); const point = { x: ((event.clientX - bounds.left) / bounds.width) * current.width, y: ((event.clientY - bounds.top) / bounds.height) * current.height }; const target = [...current.rects].reverse().find((rect) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height); if (target) onSelect(target.entity); }, [onSelect]);
  return <canvas ref={canvasRef} width={size.width} height={size.height} onClick={hit} aria-label="Live Pi instance and agent topology" role="img" />;
}

function StatusDot({ status }: { status: string }): ReactElement { return <span className={`status-dot status-${status}`} aria-label={status} />; }

function Inspector({ graph, selected, onClose }: { graph: GraphState; selected?: EntityId; onClose: () => void }): ReactElement {
  const instance = selected?.type === "instance" ? graph.instances[selected.key] : undefined;
  const agent = selected?.type === "agent" ? graph.agents[selected.key] : undefined;
  const tool = selected?.type === "tool" ? graph.tools[selected.key] : undefined;
  const peer = selected?.type === "peer" ? graph.peers[selected.key] : undefined;
  const title = instance?.displayName ?? agent?.label ?? tool?.name ?? peer?.displayName ?? "Nothing selected";
  const status = instance?.status ?? agent?.status ?? tool?.status ?? peer?.status;
  const relatedMessages = selected ? messagesForSelection(graph.messages, selected) : [];
  return <aside className="inspector" aria-label="Selected node inspector"><div className="inspector-head"><div><span className="eyebrow">NODE INSPECTOR</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close inspector"><X size={16} /></button></div>{selected ? <><div className="inspector-status"><StatusDot status={status ?? "idle"} /><b>{status}</b><span className="mono">{selected.type}</span></div><div className="metric-grid"><div><span>IDENTIFIER</span><b>{short(selected.key, 30)}</b></div><div><span>LAST SIGNAL</span><b>{instance ? relative(instance.updatedAt) : agent ? relative(agent.updatedAt) : "—"}</b></div></div>{instance && <><div className="context-meter"><div><span>CONTEXT WINDOW</span><b>{instance.contextPercent}%</b></div><div className="meter"><i style={{ width: `${Math.min(100, instance.contextPercent)}%` }} /></div></div><dl className="detail-list"><div><dt>PERSONA</dt><dd>{instance.persona || "unassigned"}</dd></div><div><dt>MODEL</dt><dd>{instance.model || "auto"}</dd></div><div><dt>PID</dt><dd>{instance.pid || "—"}</dd></div></dl></>}{agent && <dl className="detail-list"><div><dt>KIND</dt><dd>{agent.kind}</dd></div><div><dt>AGENT</dt><dd>{agent.agent ?? "—"}</dd></div><div><dt>PERSONA</dt><dd>{agent.persona ?? "—"}</dd></div></dl>}{peer && <><div className="context-meter"><div><span>CONTEXT WINDOW</span><b>{peer.contextPercent}%</b></div><div className="meter"><i style={{ width: `${Math.min(100, peer.contextPercent)}%` }} /></div></div><dl className="detail-list"><div><dt>PERSONA</dt><dd>{peer.persona || "unassigned"}</dd></div><div><dt>MODEL</dt><dd>{peer.model || "auto"}</dd></div><div><dt>SENT / RX</dt><dd>{peer.sent} / {peer.received}</dd></div></dl></>}{tool && <dl className="detail-list"><div><dt>TOOL</dt><dd>{tool.name}</dd></div><div><dt>DURATION</dt><dd>{tool.durationMs !== undefined ? `${tool.durationMs}ms` : tool.status === "running" ? "running" : "—"}</dd></div><div><dt>AGENT</dt><dd>{short(tool.agentKey, 26)}</dd></div></dl>}<div className="inspector-section"><span className="eyebrow">RECENT TRAFFIC</span>{relatedMessages.length ? relatedMessages.map((message) => <div className="traffic-row" key={message.key}><span className={`channel-mark ${message.channel}`} /><span>{message.kind}</span><b>{message.status}</b></div>) : <div className="empty-small">No message frames for this node.</div>}</div></> : <div className="empty-inspector"><CircleDot size={28} /><p>Select an instance, agent, or tool satellite to inspect live telemetry.</p></div>}</aside>;
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
  const filteredGraph = useFilteredGraph(displayedGraph, filters);
  const instances = Object.entries(panelGraph.instances); const personas = [...new Set(instances.map(([, instance]) => instance.persona).filter(Boolean))];
  const attentionCount = [...Object.values(panelGraph.instances), ...Object.values(panelGraph.agents)].filter(isAttention).length;
  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]): void => setFilters((current) => ({ ...current, [key]: value }));
  const graphToShow = filters.attention === "attention" ? { ...filteredGraph, instances: Object.fromEntries(Object.entries(filteredGraph.instances).filter(([, instance]) => isAttention(instance))), agents: Object.fromEntries(Object.entries(filteredGraph.agents).filter(([, agent]) => isAttention(agent))) } : filteredGraph;
  const runningTools = Object.values(panelGraph.tools).filter((tool) => tool.status === "running" && liveStream(panelGraph.instances[`${tool.producerId}::${tool.sessionId}`]?.status ?? "stale")).length;
  return <div className="app-shell"><header className="topbar"><div className="brand"><div className="brand-mark"><Command size={17} /></div><div><b>PI PERSONA FLOW</b><span>CONTROL ROOM <i>·</i> LOCAL TELEMETRY</span></div></div><div className="topbar-center"><span className="live-indicator"><i />{connection === "live" ? "LIVE" : connection.toUpperCase()}</span><span className="workspace-path"><Server size={13} />{instances.length > 0 ? "local workspace" : "waiting for workspace"}</span></div></header><main className="control-room"><aside className="rail"><div className="rail-section"><span className="eyebrow">SCOPE</span><label className="select-wrap"><Layers3 size={14} /><select value={filters.instance} onChange={(event) => updateFilter("instance", event.target.value)}><option value="">All instances · {instances.length}</option>{instances.map(([id, instance]) => <option key={id} value={id}>{instance.displayName}</option>)}</select></label><label className="select-wrap"><Sparkles size={14} /><select value={filters.persona} onChange={(event) => updateFilter("persona", event.target.value)}><option value="">All personas</option>{personas.map((persona) => <option key={persona} value={persona}>{persona}</option>)}</select></label></div><div className="rail-section"><span className="eyebrow">CHANNEL</span><div className="segmented" role="group" aria-label="Message channel filter">{(["all", "intercom", "exocom"] as const).map((channel) => <button key={channel} className={filters.channel === channel ? "active" : ""} onClick={() => updateFilter("channel", channel)}>{channel === "all" ? "ALL" : channel.toUpperCase()}</button>)}</div></div><div className="rail-section"><span className="eyebrow">ATTENTION</span><button className={`attention-toggle ${filters.attention === "attention" ? "active" : ""}`} onClick={() => updateFilter("attention", filters.attention === "all" ? "attention" : "all")}><AlertTriangle size={14} />Needs attention <b>{attentionCount}</b></button></div><div className="rail-section rail-stats"><span className="eyebrow">SYSTEM PULSE</span><div className="rail-stat"><Activity size={15} /><span>AGENTS</span><b>{Object.keys(graph.agents).length}</b></div><div className="rail-stat"><Wifi size={15} /><span>EXOCOM PEERS</span><b>{distinctPeers(graph)}</b></div><div className="rail-stat"><Terminal size={15} /><span>TOOLS ACTIVE</span><b>{runningTools}</b></div></div><div className="rail-legend"><span><i className="legend-dot cyan" />INTERCOM</span><span><i className="legend-dot magenta" />EXOCOM</span><span><i className="legend-line" />HIERARCHY</span></div></aside><section className="workspace"><div className="workspace-head"><div><span className="eyebrow">TOPOLOGY / {filters.attention === "attention" ? "ATTENTION VIEW" : "ALL SIGNALS"}</span><h1>Lifecycle topology</h1><p>Instances contain lifecycle graphs; semantic channels overlay directional traffic.</p></div><div className="workspace-summary"><div><span>INSTANCES</span><b>{Object.keys(graphToShow.instances).length}</b></div><div><span>EVENTS</span><b>{graph.events.length.toLocaleString()}</b></div><div className="signal-summary"><StatusDot status="running" /><span>STREAM HEALTH</span></div></div></div>{error && <div className="notice"><AlertTriangle size={14} />{error}</div>}<div className="graph-frame"><GraphCanvas graph={graphToShow} selected={selected} onSelect={(entity) => { setSelected(entity); setInspectorOpen(true); }} /><div className="graph-hint"><span><span className="keycap">CLICK</span> inspect node</span><span><span className="keycap">LIVE</span> canvas follows stream</span></div>{Object.keys(graphToShow.instances).length === 0 && Object.keys(graphToShow.peers).length === 0 && <div className="empty-graph"><Bot size={32} /><b>Awaiting Pi telemetry</b><span>Start a session to populate the control room.</span></div>}</div><Timeline events={timeline.events} playing={playing} cursor={cursor} onPlay={() => setPlaying((value) => !value)} onCursor={setCursor} /></section>{inspectorOpen && <Inspector graph={displayedGraph} selected={selected} onClose={() => setInspectorOpen(false)} />} {!inspectorOpen && <button className="reopen-inspector" onClick={() => setInspectorOpen(true)}><ChevronRight size={16} />INSPECTOR</button>}</main></div>;
}

export default App;
