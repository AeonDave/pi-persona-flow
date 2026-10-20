import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtension, browserLaunch, workspaceHash, type FlowExtensionOptions } from "../src/extension.ts";
import { FLOW_SETTINGS_CHANNEL } from "../src/settings.ts";

const url = "http://127.0.0.1:7874/?token=Ab12";
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) { assert.ok(Date.now() < deadline, "condition did not settle"); await pause(5); }
}
function mockPi(options: FlowExtensionOptions = {}, disabled = false) {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const flags = new Map<string, unknown>();
  const subscriptions = new Map<string, (value: unknown) => void>();
  const publicSubscriptions = new Map<string, Set<(value: unknown) => void>>();
  const widgets: string[] = [];
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const published: unknown[][] = [];
  const connectionOptions: unknown[] = [];
  let connections = 0;
  let closed = 0;
  const cwd = join(tmpdir(), "flow-mock-workspace");
  const context = {
    cwd, hasUI: true, sessionManager: { getSessionId: () => "mock-session" },
    ui: {
      setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
      setWidget: (_key: string, value: string[] | undefined) => { widgets.push(...value ?? []); },
      notify: (text: string) => { notices.push(text); },
    },
  } as unknown as ExtensionContext;
  const api = {
    on: (name: string, fn: unknown) => { handlers.set(name, fn); },
    registerCommand: (name: string, def: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => { commands.set(name, def); },
    registerFlag: (name: string, def: unknown) => { flags.set(name, def); },
    getFlag: (name: string) => name === "no-flow" && disabled,
    events: { on: (name: string, fn: (value: unknown) => void) => {
      if (name === "pi:telemetry" || name === "pi:telemetry:v1") {
        subscriptions.set(name, fn);
        return () => { subscriptions.delete(name); };
      }
      const handlers = publicSubscriptions.get(name) ?? new Set<(value: unknown) => void>();
      handlers.add(fn); publicSubscriptions.set(name, handlers);
      return () => { handlers.delete(fn); if (handlers.size === 0) publicSubscriptions.delete(name); };
    } },
  } as unknown as ExtensionAPI;
  const connection = {
    url, workspaceId: workspaceHash(cwd),
    heartbeat: async () => {}, publish: async (events: readonly unknown[]) => { published.push([...events]); },
    close: async () => { closed += 1; },
  };
  createExtension(api, {
    connect: async (connectOptions) => { connections += 1; connectionOptions.push(connectOptions); return connection; }, flushMs: 1,
    ...options,
  });
  return {
    handlers, commands, flags, subscriptions, publicSubscriptions, widgets, statuses, notices, published, connectionOptions, context, connection,
    get connections() { return connections; }, get closed() { return closed; },
    start: async (ctx = context) => { await (handlers.get("session_start") as (event: unknown, ctx: ExtensionContext) => Promise<void>)({}, ctx); },
    stop: async () => { await (handlers.get("session_shutdown") as () => Promise<void>)(); },
    command: async (arg: string) => { await commands.get("dashboard")!.handler(arg, context); },
    emit: (value: unknown, channel = "pi:telemetry") => { subscriptions.get(channel)?.(value); },
    collectSettings: () => {
      const values: Array<{ id: string; settings: unknown }> = [];
      for (const handler of publicSubscriptions.get(FLOW_SETTINGS_CHANNEL) ?? []) {
        handler({ add: (id: string, settings: unknown) => values.push({ id, settings }) });
      }
      return values;
    },
  };
}

async function withFlowSettings<T>(preferences: Record<string, unknown>, run: (agentDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-settings-extension-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const personaDir = join(agentDir, "persona");
  try {
    await mkdir(personaDir, { recursive: true });
    await writeFile(join(personaDir, "settings.json"), JSON.stringify({ version: 1, preferences, personas: {}, lastPersona: null }), "utf8");
    process.env.PI_AGENT_DIR = agentDir;
    return await run(agentDir);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("pi-flow-settings-extension-"));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
function event(seq: number, workspaceId = workspaceHash(join(tmpdir(), "flow-mock-workspace"))) {
  return { version: 2, producerId: "test", producerVersion: "1", id: `s:${seq}`, seq, ts: seq,
    sessionId: "s", workspaceId, type: "instance.heartbeat", payload: { status: "active" } };
}

test("factory registers /dashboard, --no-flow, and only the lifecycle hooks it uses", () => {
  const m = mockPi();
  assert.deepEqual([...m.commands.keys()], ["dashboard"]);
  assert.deepEqual([...m.flags.keys()], ["no-flow"]);
  assert.deepEqual([...m.handlers.keys()], ["session_start", "session_shutdown"]);
  assert.equal(m.connections, 0, "factory construction does not start a service");
});

test("default attachment forwards validated workspace telemetry and detaches on shutdown", async () => {
  const m = mockPi();
  await m.start();
  try {
    m.emit(event(1));
    m.emit(event(2, "foreign"));
    m.emit({ invalid: true });
    await until(() => m.published.length === 1);
    assert.equal(m.published[0]!.length, 1);
    assert.match(m.statuses.filter(Boolean).join(" | "), /127\.0\.0\.1:7874 · workspace /);
    assert.equal(m.widgets.length, 1);
    assert.equal(m.widgets[0], `flow dashboard at ${url}`);
    assert.deepEqual(m.notices, [], "no duplicate URL toast");
  } finally { await m.stop(); }
  assert.equal(m.subscriptions.size, 0);
  assert.equal(m.closed, 1);
  assert.equal(m.statuses.at(-1), undefined);
});

test("automatic headless attachment keeps stdout clean", async () => {
  const m = mockPi();
  const written: string[] = [], errors: string[] = [];
  const stdout = process.stdout.write, stderr = process.stderr.write;
  // node:test uses binary IPC on stdout; do not swallow the runner's own frames.
  process.stdout.write = ((chunk: string | Uint8Array) => { if (typeof chunk !== "string") return stdout.call(process.stdout, chunk); written.push(chunk); return true; }) as typeof stdout;
  process.stderr.write = ((chunk: string | Uint8Array) => { if (typeof chunk !== "string") return stderr.call(process.stderr, chunk); errors.push(chunk); return true; }) as typeof stderr;
  try { await m.start({ ...m.context, hasUI: false }); }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; await m.stop(); }
  assert.deepEqual(written, []);
  assert.match(errors.join(""), /flow dashboard at http:\/\/127\.0\.0\.1:7874\/\?token=/);
});

test("shutdown drains the final bounded bus batch before unregistering", async () => {
  const m = mockPi({ flushMs: 60_000 });
  await m.start();
  m.emit(event(1));
  await m.stop();
  assert.equal(m.published.length, 1, "the last bus-only lifecycle event must not disappear at shutdown");
  assert.equal(m.published[0]!.length, 1);
  assert.equal(m.closed, 1);
});

test("an ambiguous publish failure retries the same event IDs once without losing bus-only work", async () => {
  let attempts = 0;
  const batches: unknown[][] = [];
  const m = mockPi({ connect: async () => ({
    url, workspaceId: "workspace", heartbeat: async () => {}, close: async () => {},
    publish: async (batch) => { batches.push([...batch]); if (++attempts === 1) throw new Error("response lost"); },
  }) });
  await m.start(); m.emit(event(1));
  await until(() => attempts === 2);
  assert.deepEqual(batches[0], batches[1], "retry must preserve immutable wire event IDs for dedupe");
  assert.deepEqual(m.notices, []);
  await m.stop();
});

test("--no-flow creates no attachment/subscriptions, including on manual serve", async () => {
  const m = mockPi({}, true);
  await m.start(); await m.command("serve"); await m.stop();
  assert.equal(m.connections, 0);
  assert.equal(m.subscriptions.size, 0);
  assert.deepEqual(m.widgets, []);
  assert.match(m.notices.join(""), /--no-flow/);
});

test("saved Flow preferences are snapshotted at activation and can disable default startup attachment", async () => {
  await withFlowSettings({ flowEnabled: false, flowPort: 8123, flowIdleMs: 2500 }, async (agentDir) => {
    const m = mockPi();
    // Changing the file after extension activation must not alter this runtime's snapshot.
    await writeFile(join(agentDir, "persona", "settings.json"), JSON.stringify({ version: 1, preferences: { flowEnabled: true, flowPort: 9234, flowIdleMs: 3000 } }), "utf8");
    await m.start();
    try {
      assert.equal(m.connections, 0, "flowEnabled=false must prevent the default service attachment");
      assert.deepEqual(m.collectSettings(), [{ id: "flow", settings: { flowEnabled: false, flowPort: 8123, flowIdleMs: 2500 } }]);
    } finally { await m.stop(); }
  });
});

test("invalid saved preferences warn once at session_start, including headless startup", async () => {
  await withFlowSettings({ flowEnabled: true, flowPort: 8123, flowIdleMs: "unsafe" }, async () => {
    const m = mockPi();
    const written: string[] = [], errors: string[] = [];
    const stdout = process.stdout.write, stderr = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { if (typeof chunk !== "string") return stdout.call(process.stdout, chunk); written.push(chunk); return true; }) as typeof stdout;
    process.stderr.write = ((chunk: string | Uint8Array) => { if (typeof chunk !== "string") return stderr.call(process.stderr, chunk); errors.push(chunk); return true; }) as typeof stderr;
    try {
      await m.start({ ...m.context, hasUI: false });
      await m.stop();
      await m.start({ ...m.context, hasUI: false });
      assert.equal(m.connections, 2, "invalid idle preference falls back rather than disabling Flow");
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      await m.stop();
    }
    assert.deepEqual(written, []);
    assert.equal(errors.filter((text) => text.includes("saved flowIdleMs preference is invalid")).length, 1);
    assert.match(errors.join(""), /flow dashboard at/);
  });
});

test("environment config contributes the effective default while --no-flow still prevents attachment", async () => {
  await withFlowSettings({ flowEnabled: true, flowPort: 8123, flowIdleMs: 2500 }, async () => {
    const previousPort = process.env.PI_PERSONA_FLOW_PORT;
    const previousIdle = process.env.PI_PERSONA_FLOW_IDLE_MS;
    process.env.PI_PERSONA_FLOW_PORT = "9123";
    process.env.PI_PERSONA_FLOW_IDLE_MS = "3500";
    try {
      const m = mockPi({}, true);
      await m.start();
      await m.command("serve");
      assert.equal(m.connections, 0, "--no-flow wins even when the configured default is enabled");
      assert.deepEqual(m.collectSettings(), [{ id: "flow", settings: { flowEnabled: true, flowPort: 9123, flowIdleMs: 3500 } }],
        "the public settings collector reports resolved defaults before applying this run's --no-flow opt-out");
      assert.equal(m.publicSubscriptions.get(FLOW_SETTINGS_CHANNEL)?.size, 1, "settings collection uses one listener, not a timer or per-render registration");
      await m.stop();
      assert.equal(m.publicSubscriptions.has(FLOW_SETTINGS_CHANNEL), false, "the public listener is unregistered on shutdown");
      await m.start();
      assert.equal(m.publicSubscriptions.get(FLOW_SETTINGS_CHANNEL)?.size, 1, "a later lifecycle start re-registers exactly one listener");
      await m.stop();
    } finally {
      if (previousPort === undefined) delete process.env.PI_PERSONA_FLOW_PORT; else process.env.PI_PERSONA_FLOW_PORT = previousPort;
      if (previousIdle === undefined) delete process.env.PI_PERSONA_FLOW_IDLE_MS; else process.env.PI_PERSONA_FLOW_IDLE_MS = previousIdle;
    }
  });
});

test("saved port and idle preferences reach the next Flow service start", async () => {
  await withFlowSettings({ flowEnabled: true, flowPort: 8234, flowIdleMs: 1_250 }, async () => {
    const previousPort = process.env.PI_PERSONA_FLOW_PORT;
    const previousIdle = process.env.PI_PERSONA_FLOW_IDLE_MS;
    delete process.env.PI_PERSONA_FLOW_PORT;
    delete process.env.PI_PERSONA_FLOW_IDLE_MS;
    try {
      const m = mockPi();
      await m.start();
      try {
        assert.deepEqual(m.connectionOptions[0], {
          agentDir: process.env.PI_AGENT_DIR,
          cwd: m.context.cwd,
          sessionId: "mock-session",
          port: 8234,
          idleMs: 1_250,
          signal: (m.connectionOptions[0] as { signal?: AbortSignal }).signal,
        });
      } finally { await m.stop(); }
    } finally {
      if (previousPort === undefined) delete process.env.PI_PERSONA_FLOW_PORT; else process.env.PI_PERSONA_FLOW_PORT = previousPort;
      if (previousIdle === undefined) delete process.env.PI_PERSONA_FLOW_IDLE_MS; else process.env.PI_PERSONA_FLOW_IDLE_MS = previousIdle;
    }
  });
});

for (const marker of ["PI_PERSONA_LEG", "PI_PERSONA_CHILD"] as const) {
  test(`dedicated worker marker ${marker} registers nothing`, () => {
    const saved = process.env[marker]; process.env[marker] = "1";
    try { const m = mockPi(); assert.equal(m.handlers.size + m.commands.size + m.flags.size, 0); }
    finally { if (saved === undefined) delete process.env[marker]; else process.env[marker] = saved; }
  });
}
test("PI_PERSONA_DISABLE is not a worker marker", () => {
  const saved = process.env.PI_PERSONA_DISABLE; process.env.PI_PERSONA_DISABLE = "1";
  try { assert.ok(mockPi().commands.has("dashboard")); }
  finally { if (saved === undefined) delete process.env.PI_PERSONA_DISABLE; else process.env.PI_PERSONA_DISABLE = saved; }
});

test("stop closes only this attachment and concurrent serve shares one connect", async () => {
  const m = mockPi(); await m.start(); await m.command("stop");
  assert.equal(m.closed, 1);
  await m.command("status");
  assert.match(m.notices.at(-1)!, /detached/);
  await m.command("typo"); assert.equal(m.connections, 1);
  await Promise.all([m.command("serve"), m.command("serve")]);
  assert.equal(m.connections, 2, "not one connection per simultaneous command");
  await m.stop();
});

test("stop cancels a pending connect and closes its late result without announcing", async () => {
  let resolve!: (value: typeof m.connection) => void;
  const pending = new Promise<typeof m.connection>((done) => { resolve = done; });
  let signal: AbortSignal | undefined;
  const m = mockPi({ connect: async (options) => { signal = options.signal; return pending; } });
  const starting = m.start();
  await until(() => signal !== undefined);
  const stopping = m.command("stop");
  assert.equal(signal?.aborted, true);
  resolve(m.connection);
  await Promise.all([starting, stopping]);
  assert.equal(m.closed, 1);
  assert.equal(m.widgets.length, 0);
  assert.equal(m.subscriptions.size, 0);
});

test("the bus queue is bounded, serial, and does not clone graph state or redraw per event", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((done) => { release = done; });
  let publishes = 0, inFlight = 0, peak = 0;
  const m = mockPi({ connect: async () => ({
    url, workspaceId: workspaceHash(join(tmpdir(), "flow-mock-workspace")), heartbeat: async () => {}, close: async () => {},
    publish: async () => { publishes += 1; inFlight += 1; peak = Math.max(peak, inFlight); await blocked; inFlight -= 1; },
  }) });
  await m.start();
  const before = m.statuses.length;
  m.emit(event(1)); await until(() => publishes === 1);
  for (let seq = 2; seq < 400; seq += 1) m.emit(event(seq));
  assert.equal(m.notices.filter((text) => text.includes("queue is full")).length, 1);
  assert.equal(m.statuses.length, before, "bus ticks must not redraw the Pi footer");
  release(); await until(() => publishes === 2);
  assert.equal(peak, 1);
  await m.stop();
});

test("heartbeat failure is visible, and manual serve reconnects instead of returning a dead client", async () => {
  let connects = 0;
  const m = mockPi({ heartbeatMs: 5, connect: async () => {
    connects += 1;
    return { url, workspaceId: "workspace", publish: async () => {}, close: async () => {},
      heartbeat: async () => { if (connects === 1) throw new Error("offline"); } };
  } });
  await m.start();
  await until(() => m.notices.some((text) => text.includes("unavailable")));
  assert.match(m.statuses.at(-1)!, /unavailable/);
  await m.command("serve"); assert.equal(connects, 2);
  assert.match(m.statuses.at(-1)!, /127\.0\.0\.1/);
  await m.stop();
});

test("dashboard never collides with pi-persona commands", () => {
  const m = mockPi();
  const roots = [process.env.PI_PERSONA_REPO, fileURLToPath(new URL("../../pi-persona/", import.meta.url))];
  const host = roots.map((root) => root && join(root, "src", "extension.ts")).find((candidate) => candidate && existsSync(candidate));
  if (!host) return;
  const taken = new Set([...readFileSync(host, "utf8").matchAll(/registerCommand\("([a-z-]+)"/g)].map((match) => match[1]!));
  assert.deepEqual([...m.commands.keys()].filter((name) => taken.has(name)), []);
});
test("browser launch never reparses URL through cmd.exe", () => {
  const target = `${url}&x=1`;
  assert.deepEqual(browserLaunch("win32", target), { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", target] });
  assert.equal(browserLaunch("darwin", target).cmd, "open");
  assert.equal(browserLaunch("linux", target).cmd, "xdg-open");
});
