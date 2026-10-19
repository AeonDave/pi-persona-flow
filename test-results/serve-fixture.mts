/** Local browser-acceptance fixture. Feeds the store through the REAL wire boundary
 * (parseTelemetryEvent) so the rendered dashboard can only show what a producer may actually publish. */
import { EventStore } from "../src/event-store.ts";
import { startServer } from "../src/server.ts";
import { parseTelemetryEvent, TELEMETRY_VERSION } from "../shared/protocol.ts";

const workspaceId = "0123456789abcdef01234567";
const store = new EventStore();
const ts = Date.now();

/** Two independent producers share one workspace, and a second producer reuses the SAME session id
 * and the SAME seq numbers — the multi-producer scoping is what keeps them from colliding. */
const raw: Array<{ producerId: string; producerVersion: string; sessionId: string; seq: number; type: string; payload: Record<string, unknown> }> = [
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 1, type: "instance.started", payload: { displayName: "Alpha", persona: "operator", model: "fixture/model", status: "active", pid: 42, contextPercent: 28, exocomEnabled: true } },
  // task/detail are caller-side fields that must NOT survive projection — the dashboard must show none of this.
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 2, type: "agent.added", payload: { id: "scout", label: "Scout", kind: "subagent", status: "running", task: "Authorization: Bearer sk-live-CANARY", detail: "cat /etc/shadow" } },
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 3, type: "tool.started", payload: { callId: "call-1", agentId: "scout", name: "bash", status: "running" } },
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 4, type: "peers.snapshot", payload: { peers: [{ sessionId: "peer-1", displayName: "Remote", persona: "reviewer", model: "fixture/model", contextPercent: 12, status: "online", sent: 2, received: 3, color: "#f083d7" }] } },
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 5, type: "message.sent", payload: { id: "message-1", channel: "exocom", from: "alpha", to: "peer-1", kind: "status", status: "delivered", expectsReply: false, size: 12 } },
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 6, type: "tool.finished", payload: { callId: "call-1", agentId: "scout", name: "bash", status: "done", durationMs: 1200 } },
  { producerId: "pi-persona", producerVersion: "1.16.0", sessionId: "alpha", seq: 7, type: "agent.updated", payload: { id: "scout", patch: { label: "Dewglass", status: "waiting" } } },
  { producerId: "pi-persona", producerVersion: "1.16.0", sessionId: "alpha", seq: 8, type: "message.received", payload: { id: "ask-1", channel: "intercom", from: "scout", to: "supervisor", kind: "decision", status: "delivered", expectsReply: true, size: 24 } },
  // A different plugin, same session id, same seq range: must render as its own stream, not overwrite Alpha.
  { producerId: "other.plugin", producerVersion: "0.3.1", sessionId: "alpha", seq: 1, type: "instance.started", payload: { displayName: "Other plugin", status: "active" } },
  { producerId: "other.plugin", producerVersion: "0.3.1", sessionId: "alpha", seq: 2, type: "agent.added", payload: { id: "worker", label: "Worker", kind: "job", status: "running" } },
  // An unreviewed namespaced type: envelope is kept, payload must be reduced to {}.
  { producerId: "other.plugin", producerVersion: "0.3.1", sessionId: "alpha", seq: 3, type: "other.plugin.state.changed", payload: { state: "ready", apiKey: "sk-live-CANARY" } },
];

// Ten independent Pi supervisors, plus the deliberately colliding third-party stream above.
// Reused worker IDs and display names exercise identity, scrolling, filters and inspector limits.
for (let index = 2; index <= 10; index += 1) {
  const sessionId = `pi-${index}`;
  const base = { producerId: "pi-persona", producerVersion: "1.16.3", sessionId };
  raw.push(
    { ...base, seq: 1, type: "instance.started", payload: { displayName: index === 2 ? "Alpha" : `Pi ${index}`, persona: "operator", model: "fixture/model", status: "active", exocomEnabled: index <= 6 } },
    { ...base, seq: 2, type: "agent.added", payload: { id: "scout", label: `Worker ${index}`, kind: "subagent", status: index === 10 ? "waiting" : "running" } },
  );
  if (index <= 6) raw.push({ ...base, seq: 3, type: "peers.snapshot", payload: { peers: [{ sessionId: "alpha", displayName: "Alpha", persona: "operator", model: "fixture/model", contextPercent: 28, status: "online", sent: 1, received: 1 }] } });
  if (index === 10) {
    let seq = 2;
    for (let tool = 0; tool < 15; tool += 1) {
      raw.push(
        { ...base, seq: ++seq, type: "tool.started", payload: { callId: `call-${tool}`, agentId: "scout", name: "read", status: "running" } },
        { ...base, seq: ++seq, type: "tool.finished", payload: { callId: `call-${tool}`, agentId: "scout", name: "read", status: tool === 14 ? "failed" : "done", durationMs: 40 + tool } },
        { ...base, seq: ++seq, type: "message.received", payload: { id: `ask-${tool}`, channel: "intercom", from: "scout", to: "supervisor", kind: "decision", status: "delivered", expectsReply: true, size: 32 } },
      );
    }
  }
}

let rejected = 0;
for (const event of raw) {
  const parsed = parseTelemetryEvent({ ...event, version: TELEMETRY_VERSION, id: `${event.producerId}:${event.sessionId}:${event.seq}`, ts, workspaceId });
  if (!parsed) { rejected += 1; continue; }
  store.append(parsed);
}

const server = await startServer({ port: 0, store, staticDir: "./dist/web", heartbeatMs: 1000 });
if (rejected !== 0) { await server.close(); throw new Error(`Acceptance fixture rejected ${rejected} wire events`); }
console.log(JSON.stringify({ url: server.url, port: server.port, token: server.token, ingested: raw.length - rejected, rejected }));
// Keep the acceptance fixture live while inspecting it, without generating a continuous UI stream.
const streams = new Map<string, { producerId: string; sessionId: string; seq: number }>();
for (const event of raw) {
  const key = JSON.stringify([event.producerId, event.sessionId]);
  const previous = streams.get(key);
  if (!previous || event.seq > previous.seq) streams.set(key, { producerId: event.producerId, sessionId: event.sessionId, seq: event.seq });
}
const heartbeat = setInterval(() => {
  for (const stream of streams.values()) {
    const { producerId, sessionId } = stream;
    const next = ++stream.seq;
    const parsed = parseTelemetryEvent({ version: TELEMETRY_VERSION, producerId, producerVersion: "1.0.0",
      id: `${producerId}:${sessionId}:${next}`, seq: next, ts: Date.now(), sessionId, workspaceId,
      type: "instance.heartbeat", payload: { status: "active" } });
    if (parsed) store.append(parsed);
  }
}, 30_000);
const shutdown = async () => { clearInterval(heartbeat); await server.close(); };
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
setTimeout(() => void shutdown(), 600_000).unref();
