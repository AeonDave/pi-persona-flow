/** Actual native shared-service browser fixture. `add` on stdin attaches another workspace. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { connectFlowService, type FlowServiceClient } from "../src/service/client.ts";
import { waitForServiceIdle } from "../test/setup/service-cleanup.ts";

const root = await mkdtemp(join(tmpdir(), "flow-browser-workspaces-"));
const agentDir = join(root, "profile");
process.env.PI_PERSONA_FLOW_IDLE_MS = "250";
const clients: FlowServiceClient[] = [];
const streams: Array<{ client: FlowServiceClient; sessionId: string; seq: number }> = [];
const metadata = (client: FlowServiceClient, sessionId: string, seq: number, type: string, payload: unknown) => ({
  version: 2, producerId: "pi-persona", producerVersion: "1.16.3", workspaceId: client.workspaceId,
  sessionId, id: `${sessionId}:${seq}`, seq, ts: Date.now(), type, payload,
});
async function attach(label: string, prefix: string, count: number): Promise<void> {
  const cwd = join(root, label);
  await mkdir(cwd, { recursive: true });
  for (let index = 1; index <= count; index += 1) {
    // Same producer/session/agent IDs in different workspaces MUST remain separate.
    const sessionId = `pi-${index}`;
    const client = await connectFlowService({ agentDir, cwd, sessionId, port: 0 });
    clients.push(client);
    const events = [
      metadata(client, sessionId, 1, "instance.started", { displayName: index === 1 ? "Alpha" : `${prefix} Pi ${index}`, status: "active", exocomEnabled: index <= 3, model: "fixture/local" }),
      metadata(client, sessionId, 2, "agent.added", { id: "workflow", label: `${prefix} workflow ${index}`, kind: "flow", status: "running" }),
      metadata(client, sessionId, 3, "agent.added", { id: "worker", parentId: "workflow", label: `${prefix} worker ${index}`, kind: "subagent", status: index === 1 ? "waiting" : "running" }),
      metadata(client, sessionId, 4, "tool.started", { callId: "read-1", agentId: "worker", name: "read", status: "running", body: "CANARY-must-not-appear" }),
      metadata(client, sessionId, 5, "tool.finished", { callId: "read-1", agentId: "worker", name: "read", status: "done", durationMs: 15 }),
    ];
    await client.publish(events);
    streams.push({ client, sessionId, seq: 5 });
  }
}
await attach("client", "Client", 5);
await attach("api", "API", 5);
console.log(JSON.stringify({ url: clients[0]!.url, workspaces: 2, sessions: clients.length }));
const heartbeat = setInterval(() => {
  void Promise.all(streams.map(async (stream) => {
    await stream.client.heartbeat();
    await stream.client.publish([metadata(stream.client, stream.sessionId, ++stream.seq, "instance.heartbeat", { status: "active" })]);
  })).catch((error: unknown) => console.error(error));
}, 5_000);
let closing: Promise<void> | undefined;
const input = createInterface({ input: process.stdin });
async function close(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    clearInterval(heartbeat); input.close();
    await Promise.all(clients.map((client) => client.close()));
    await waitForServiceIdle(agentDir);
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("flow-browser-workspaces-")) throw new Error("unexpected cleanup path");
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  })();
  return closing;
}
input.on("line", (line) => {
  if (line.trim() === "add") void attach("analysis", "Analysis", 1).then(() => console.log("workspace analysis attached"));
  if (line.trim() === "stop") void close();
});
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
setTimeout(() => { void close(); }, 600_000).unref();
