import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtension, browserLaunch, workspaceHash, type FlowExtensionOptions } from "../src/extension.ts";

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
  const widgets: string[] = [];
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const published: unknown[][] = [];
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
    events: { on: (name: string, fn: (value: unknown) => void) => { subscriptions.set(name, fn); return () => { subscriptions.delete(name); }; } },
  } as unknown as ExtensionAPI;
  const connection = {
    url, workspaceId: workspaceHash(cwd),
    heartbeat: async () => {}, publish: async (events: readonly unknown[]) => { published.push([...events]); },
    close: async () => { closed += 1; },
  };
  createExtension(api, {
    connect: async () => { connections += 1; return connection; }, flushMs: 1,
    ...options,
  });
  return {
    handlers, commands, flags, subscriptions, widgets, statuses, notices, published, context, connection,
    get connections() { return connections; }, get closed() { return closed; },
    start: async (ctx = context) => { await (handlers.get("session_start") as (event: unknown, ctx: ExtensionContext) => Promise<void>)({}, ctx); },
    stop: async () => { await (handlers.get("session_shutdown") as () => Promise<void>)(); },
    command: async (arg: string) => { await commands.get("dashboard")!.handler(arg, context); },
    emit: (value: unknown, channel = "pi:telemetry") => { subscriptions.get(channel)?.(value); },
  };
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
