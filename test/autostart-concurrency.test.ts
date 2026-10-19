import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { workspaceHash } from "../src/extension.ts";
import { EventStore } from "../src/event-store.ts";
import { startServer } from "../src/server.ts";
import { waitForServiceIdle } from "./setup/service-cleanup.ts";

test("ten default Pi clients share one dashboard despite a port collision", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-ten-sessions-"));
  const saved = { agent: process.env.PI_AGENT_DIR, host: process.env.PI_CODING_AGENT_DIR, port: process.env.PI_PERSONA_FLOW_PORT, idle: process.env.PI_PERSONA_FLOW_IDLE_MS };
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const workspaceId = workspaceHash(cwd);
  const logDir = join(agentDir, "telemetry", "v2", workspaceId, "pi-persona");
  const shutdowns: Array<() => Promise<void>> = [];
  const occupied = await startServer({ port: 0, store: new EventStore() });
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(logDir, { recursive: true });
    process.env.PI_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_PERSONA_FLOW_PORT = String(occupied.port);
    process.env.PI_PERSONA_FLOW_IDLE_MS = "1500";
    await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const sessionId = `pi-${i}`;
      const events = [
        { seq: 1, type: "instance.started", payload: { displayName: `Pi ${i}`, status: "active", exocomEnabled: i < 6 } },
        { seq: 2, type: "agent.added", payload: { id: "same-worker-id", label: `Worker ${i}`, kind: "subagent", status: "running" } },
        ...(i < 6 ? [{ seq: 3, type: "peers.snapshot", payload: { peers: [{ sessionId: `pi-${i ^ 1}`, displayName: `Pi ${i ^ 1}`, status: "online" }] } }] : []),
      ].map((event) => ({ ...event, version: 2, producerId: "pi-persona", producerVersion: "1.16.3", workspaceId, sessionId, id: `${sessionId}:${event.seq}`, ts: Date.now() }));
      await writeFile(join(logDir, `${sessionId}.jsonl`), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    }));
    const urls = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const subscriptions = new Map<string, (value: unknown) => void>();
      const widgets: string[] = [];
      const api = {
        on: (name: string, fn: (...args: unknown[]) => unknown) => { handlers.set(name, fn); },
        registerCommand: () => {}, registerFlag: () => {}, getFlag: () => undefined,
        events: { on: (name: string, fn: (value: unknown) => void) => { subscriptions.set(name, fn); return () => { subscriptions.delete(name); }; } },
      } as unknown as ExtensionAPI;
      extension(api);
      const shutdown = async () => { await handlers.get("session_shutdown")?.(); assert.equal(subscriptions.size, 0); };
      shutdowns.push(shutdown);
      await handlers.get("session_start")?.({}, { cwd, sessionManager: { getSessionId: () => `pi-${index}` }, hasUI: true, ui: {
        setStatus: () => {}, notify: () => {},
        setWidget: (_key: string, lines: string[] | undefined) => { widgets.push(...lines ?? []); },
      } });
      const url = widgets.find((line) => line.startsWith("flow dashboard at "))?.slice("flow dashboard at ".length);
      assert.ok(url, "each independent Pi must announce the shared listener");
      return url;
    }));
    assert.equal(new Set(urls).size, 1, "all clients must attach to one shared service and browser URL");
    await Promise.all(urls.map(async (url) => {
      const endpoint = new URL(url);
      endpoint.pathname = "/api/snapshot";
      type Snapshot = { state: { instances: Record<string, unknown>; agents: Record<string, unknown>; peers: Record<string, unknown> } };
      // Ingestion deliberately budgets work per tick; opening a dashboard is not a synchronous
      // drain of ten files. Wait for the observable condition, not a guessed fixed sleep.
      const deadline = Date.now() + 5_000;
      let snapshot: Snapshot;
      for (;;) {
        const response = await fetch(endpoint);
        assert.equal(response.status, 200);
        snapshot = await response.json() as Snapshot;
        if (Object.keys(snapshot.state.instances).length === 10 || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(Object.keys(snapshot.state.instances).length, 10);
      assert.equal(Object.keys(snapshot.state.agents).length, 10, "reused child IDs must remain scoped to each supervisor");
      assert.equal(Object.keys(snapshot.state.peers).length, 6);
      endpoint.search = "";
      assert.equal((await fetch(endpoint)).status, 401);
    }));
    await shutdowns[0]!();
    const survivor = new URL(urls[1]!);
    survivor.pathname = "/api/snapshot";
    assert.equal((await fetch(survivor)).status, 200, "stopping one Pi must not stop another's dashboard");
  } finally {
    await Promise.all(shutdowns.map((shutdown) => shutdown()));
    await waitForServiceIdle(agentDir);
    await occupied.close();
    for (const [key, value] of [["PI_AGENT_DIR", saved.agent], ["PI_CODING_AGENT_DIR", saved.host], ["PI_PERSONA_FLOW_PORT", saved.port], ["PI_PERSONA_FLOW_IDLE_MS", saved.idle]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("flow-ten-sessions-"));
    await rm(root, { recursive: true, force: true });
  }
});
