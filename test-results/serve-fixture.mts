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
const raw = [
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 1, type: "instance.started", payload: { displayName: "Alpha", persona: "operator", model: "fixture/model", status: "active", pid: 42, contextPercent: 28, exocomEnabled: true } },
  // task/detail are caller-side fields that must NOT survive projection — the dashboard must show none of this.
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 2, type: "agent.added", payload: { id: "scout", label: "Scout", kind: "subagent", status: "running", task: "Authorization: Bearer sk-live-CANARY", detail: "cat /etc/shadow" } },
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 3, type: "tool.started", payload: { callId: "call-1", agentId: "scout", name: "bash", status: "running" } },
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 4, type: "peers.snapshot", payload: { peers: [{ sessionId: "peer-1", displayName: "Remote", persona: "reviewer", model: "fixture/model", contextPercent: 12, status: "online", sent: 2, received: 3, color: "#f083d7" }] } },
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 5, type: "message.sent", payload: { id: "message-1", channel: "exocom", from: "alpha", to: "peer-1", kind: "status", status: "delivered", expectsReply: false, size: 12 } },
  { producerId: "pi-persona", producerVersion: "1.10.5", sessionId: "alpha", seq: 6, type: "tool.finished", payload: { callId: "call-1", agentId: "scout", name: "bash", status: "done", durationMs: 1200 } },
  // A different plugin, same session id, same seq range: must render as its own stream, not overwrite Alpha.
  { producerId: "other.plugin", producerVersion: "0.3.1", sessionId: "alpha", seq: 1, type: "instance.started", payload: { displayName: "Other plugin", status: "active" } },
  { producerId: "other.plugin", producerVersion: "0.3.1", sessionId: "alpha", seq: 2, type: "agent.added", payload: { id: "worker", label: "Worker", kind: "job", status: "running" } },
  // An unreviewed namespaced type: envelope is kept, payload must be reduced to {}.
  { producerId: "other.plugin", producerVersion: "0.3.1", sessionId: "alpha", seq: 3, type: "other.plugin.state.changed", payload: { state: "ready", apiKey: "sk-live-CANARY" } },
];

let rejected = 0;
for (const event of raw) {
  const parsed = parseTelemetryEvent({ ...event, version: TELEMETRY_VERSION, id: `${event.producerId}:${event.sessionId}:${event.seq}`, ts, workspaceId });
  if (!parsed) { rejected += 1; continue; }
  store.append(parsed);
}

const server = await startServer({ port: 0, store, staticDir: "./dist/web", heartbeatMs: 1000 });
console.log(JSON.stringify({ url: server.url, port: server.port, token: server.token, ingested: raw.length - rejected, rejected }));
setTimeout(() => void server.close(), 120_000).unref();
