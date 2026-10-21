import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SERVICE_DESCRIPTOR_FILE, SERVICE_DIRECTORY, type SharedServiceDescriptor } from "../shared/workspaces.ts";
import { createExtension, workspaceHash } from "../src/extension.ts";
import type { TelemetrySnapshot } from "../src/event-store.ts";

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function until(check: () => Promise<boolean> | boolean, description: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await pause(25);
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function mockPi(cwd: string) {
  const lifecycle = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const subscriptions = new Map<string, Set<(value: unknown) => void>>();
  const widgets: Array<string[] | undefined> = [];
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const ctx = {
    cwd, hasUI: true, sessionManager: { getSessionId: () => "extension-recovery-session" },
    ui: {
      setWidget: (_key: string, value: string[] | undefined) => { widgets.push(value); },
      setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
      notify: (value: string) => { notices.push(value); },
    },
  } as unknown as ExtensionContext;
  const api = {
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<void>) => { lifecycle.set(name, fn); },
    // The test never invokes /dashboard: recovery must be automatic.
    registerCommand: () => {}, registerFlag: () => {}, getFlag: () => false,
    events: { on: (name: string, fn: (value: unknown) => void) => {
      const handlers = subscriptions.get(name) ?? new Set<(value: unknown) => void>();
      handlers.add(fn); subscriptions.set(name, handlers);
      return () => { handlers.delete(fn); if (!handlers.size) subscriptions.delete(name); };
    } },
  } as unknown as ExtensionAPI;
  createExtension(api, { heartbeatMs: 25, flushMs: 5, retryMs: 250 });
  return {
    widgets, statuses, notices, subscriptions,
    start: () => lifecycle.get("session_start")!({}, ctx),
    stop: () => lifecycle.get("session_shutdown")!({}, ctx),
    emit: (seq: number) => {
      const event = {
        version: 2, producerId: "recovery-bus-only", producerVersion: "1", id: `recovery:${seq}`, seq,
        ts: Date.now(), sessionId: "extension-recovery-session", workspaceId: workspaceHash(cwd),
        type: "instance.heartbeat", payload: { status: "active", displayName: `bus-event-${seq}` },
      };
      for (const handler of subscriptions.get("pi:telemetry") ?? []) handler(event);
    },
  };
}

async function snapshot(descriptor: SharedServiceDescriptor, cwd: string): Promise<TelemetrySnapshot> {
  const url = new URL(descriptor.url);
  url.pathname = "/api/snapshot";
  url.searchParams.set("workspace", workspaceHash(cwd));
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  assert.equal(response.status, 200, "Authenticated snapshot must remain available");
  return await response.json() as TelemetrySnapshot;
}

test("a live Pi attachment automatically replaces a crashed daemon and delivers bus-only outage events", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-extension-recovery-"));
  const agentDir = join(root, "isolated pi profile"), cwd = join(root, "workspace");
  const descriptorPath = join(agentDir, SERVICE_DIRECTORY, SERVICE_DESCRIPTOR_FILE);
  const previousEnv = new Map(["PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_PERSONA_FLOW_PORT", "PI_PERSONA_FLOW_IDLE_MS"]
    .map((key) => [key, process.env[key]] as const));
  const owned = new Map<string, SharedServiceDescriptor>();
  let extension: ReturnType<typeof mockPi> | undefined;
  const readDescriptor = async (): Promise<SharedServiceDescriptor | undefined> => {
    let value: SharedServiceDescriptor;
    try { value = JSON.parse(await readFile(descriptorPath, "utf8")) as SharedServiceDescriptor; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid !== process.pid);
    owned.set(value.serviceId, value);
    return value;
  };
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    process.env.PI_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_PERSONA_FLOW_PORT = "0";
    // A cold native Node startup needs time to register before the daemon becomes idle.
    process.env.PI_PERSONA_FLOW_IDLE_MS = "1500";
    extension = mockPi(cwd);
    await extension.start();
    const first = await readDescriptor();
    assert.ok(first, "Initial attachment must start its isolated daemon");
    extension.emit(1);
    await until(async () => (await snapshot(first, cwd)).cursor === 1, "initial bus event ingestion");
    const initialStatus = extension.statuses.at(-1);
    assert.ok(initialStatus?.includes(new URL(first.url).host));
    assert.deepEqual(extension.widgets.at(-1), [`flow dashboard at ${first.url}`]);

    // This PID comes only from the descriptor beneath this exact fixture profile.
    process.kill(first.pid, "SIGKILL");
    await until(() => !processIsAlive(first.pid), "the owned crashed process to exit");
    await until(() => extension!.statuses.at(-1) !== initialStatus, "outage detection");
    extension.emit(2);
    extension.emit(3);

    let replacement: SharedServiceDescriptor | undefined;
    await until(async () => {
      const current = await readDescriptor();
      if (current && current.serviceId !== first.serviceId) { replacement = current; return true; }
      return false;
    }, "automatic shared-service election and replacement");
    assert.ok(replacement);
    assert.notEqual(replacement.pid, first.pid);
    assert.equal(replacement.url, first.url, "Automatic daemon recovery must preserve an already-open browser URL");
    assert.notEqual(replacement.controlToken, first.controlToken, "A new daemon must rotate its private control credentials");
    await until(async () => {
      const url = new URL(replacement!.url);
      url.pathname = "/api/workspaces";
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      assert.equal(response.status, 200);
      const catalog = await response.json() as { workspaces: Array<{ id: string; activeSessions: number }> };
      return catalog.workspaces.some((workspace) => workspace.id === workspaceHash(cwd) && workspace.activeSessions === 1);
    }, "the recovered attachment to register its workspace");
    await until(async () => {
      // The original browser link must authenticate against the replacement daemon too.
      const current = await snapshot(first, cwd);
      return current.cursor === 2 && Object.values(current.state.instances).some((instance) => instance.displayName === "bus-event-3");
    }, "bus-only outage events to reach the replacement without a command");
    await until(() => extension!.widgets.at(-1)?.[0] === `flow dashboard at ${replacement!.url}`, "the UI widget to show the recovered URL");
    assert.ok(extension.statuses.at(-1)?.includes(new URL(replacement.url).host), "Recovered footer must use the current daemon address");
    assert.ok(!extension.notices.some((notice) => /Run \/dashboard serve/.test(notice)), "Automatic recovery must not request operator intervention");
  } finally {
    try {
      await extension?.stop();
      assert.equal(extension?.subscriptions.size ?? 0, 0, "Shutdown must release event listeners");
      // Joining stop also joins any in-flight election before the descriptor is read for cleanup.
      await readDescriptor();
      for (const descriptor of owned.values()) {
        try { await until(() => !processIsAlive(descriptor.pid), "the owned daemon's idle shutdown", 8_000); }
        catch (error) {
          // Failure cleanup stays limited to services discovered inside this fixture profile.
          if (processIsAlive(descriptor.pid)) process.kill(descriptor.pid, "SIGKILL");
          await until(() => !processIsAlive(descriptor.pid), "the exact fixture daemon to finish cleanup");
          throw error;
        }
      }
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("pi-flow-extension-recovery-"));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
