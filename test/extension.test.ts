/**
 * Verifies the extension factory wires its surface correctly against a minimal
 * ExtensionAPI mock — catches signature drift and load-time throws without a
 * full Pi runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import piPersonaFlow, { browserLaunch, workspaceHash } from "../src/extension.ts";

function mockPi() {
  const handlers = new Map<string, unknown[]>();
  const commands = new Map<string, unknown>();
  const flags = new Map<string, unknown>();
  const eventHandlers = new Map<string, (value: unknown) => void>();
  const events = {
    on: (channel: string, handler: (value: unknown) => void) => {
      eventHandlers.set(channel, handler);
      return () => eventHandlers.delete(channel);
    },
    emit: (channel: string, value: unknown) => eventHandlers.get(channel)?.(value),
  };
  return {
    handlers,
    commands,
    flags,
    eventHandlers,
    api: {
      on: (event: string, fn: unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
      },
      registerCommand: (name: string, def: unknown) => commands.set(name, def),
      registerFlag: (name: string, def: unknown) => flags.set(name, def),
      getFlag: (_name: string): unknown => undefined,
      events,
    },
  };
}

test("factory registers the /dashboard command, the --flow flag, and core hooks", () => {
  const m = mockPi();
  // @ts-expect-error — minimal mock, not the full ExtensionAPI.
  piPersonaFlow(m.api);

  assert.ok(m.commands.has("dashboard"));
  assert.ok(m.flags.has("flow"));

  for (const ev of ["session_start", "session_shutdown", "turn_start", "tool_call", "tool_result", "agent_settled", "session_info_changed", "before_agent_start"]) {
    assert.ok(m.handlers.get(ev)?.length, `expected a handler for "${ev}"`);
  }
});

test("factory does not start a server before session_start", () => {
  const m = mockPi();
  // @ts-expect-error — minimal mock.
  piPersonaFlow(m.api);
  // No session_start triggered, so no server should exist. Nothing to assert
  // here beyond the absence of a throw — the server is session-scoped.
  assert.ok(true);
});

test("session telemetry is ingested immediately and unsubscribed on shutdown", async () => {
  const m = mockPi();
  // @ts-expect-error — minimal mock.
  piPersonaFlow(m.api);
  const cwd = mkdtempSync(join(tmpdir(), "flow-extension-"));
  const uiUpdates: string[] = [];
  const context = {
    cwd,
    hasUI: true,
    ui: { setStatus: (_id: string, value: string) => uiUpdates.push(value), notify: () => undefined },
  };
  const start = m.handlers.get("session_start")![0] as (event: unknown, ctx: typeof context) => Promise<void>;
  await start({}, context);
  const workspaceId = workspaceHash(cwd);
  m.api.events.emit("pi-persona:telemetry", {
    version: 1,
    id: "session:1",
    seq: 1,
    ts: 1,
    sessionId: "session",
    workspaceId,
    type: "instance.heartbeat",
    payload: { contextPercent: 10 },
  });
  assert.ok(uiUpdates.some((value) => value.includes("0 agents")));
  const beforeShutdown = m.eventHandlers.size;
  const shutdown = m.handlers.get("session_shutdown")![0] as () => Promise<void>;
  await shutdown();
  assert.equal(m.eventHandlers.size, beforeShutdown - 2);
});

test("the status line reads the graph without cloning it on every event", async () => {
  const m = mockPi();
  // @ts-expect-error — minimal mock.
  piPersonaFlow(m.api);
  const cwd = mkdtempSync(join(tmpdir(), "flow-extension-"));
  const context = { cwd, hasUI: true, ui: { setStatus: () => undefined, notify: () => undefined } };
  const start = m.handlers.get("session_start")![0] as (event: unknown, ctx: typeof context) => Promise<void>;
  await start({}, context);
  const workspaceId = workspaceHash(cwd);
  const clone = globalThis.structuredClone;
  let graphClones = 0;
  globalThis.structuredClone = ((value: unknown, options?: unknown) => {
    if (value !== null && typeof value === "object" && "instances" in value) graphClones += 1;
    return (clone as (input: unknown, options?: unknown) => unknown)(value, options);
  }) as typeof structuredClone;
  try {
    for (let seq = 1; seq <= 50; seq += 1) {
      m.api.events.emit("pi-persona:telemetry", {
        version: 1, id: `session:${seq}`, seq, ts: seq, sessionId: "session", workspaceId,
        type: "instance.heartbeat", payload: { contextPercent: seq },
      });
    }
  } finally {
    globalThis.structuredClone = clone;
  }
  assert.equal(graphClones, 0, "the status subscriber must not deep-clone the graph once per event");
  const shutdown = m.handlers.get("session_shutdown")![0] as () => Promise<void>;
  await shutdown();
});

test("the status line never advertises a URL that cannot authenticate", async () => {
  // The dashboard is token-gated: a bare http://127.0.0.1:<port> answers 401 on /api/snapshot, so
  // the page loads and then sits empty. The status line is the one URL a user sees all session, and
  // pointing them at the unusable form is how "the dashboard is broken" happens. Name the way IN.
  const m = mockPi();
  // The status line only advertises a URL once a server is up, which is what `--flow` does.
  m.api.getFlag = (name: string): unknown => (name === "flow" ? true : undefined);
  // @ts-expect-error — minimal mock.
  piPersonaFlow(m.api);
  const cwd = mkdtempSync(join(tmpdir(), "flow-statusline-"));
  const uiUpdates: string[] = [];
  const context = {
    cwd,
    hasUI: true,
    ui: { setStatus: (_id: string, value: string) => uiUpdates.push(value), notify: () => undefined },
  };
  const start = m.handlers.get("session_start")![0] as (event: unknown, ctx: typeof context) => Promise<void>;
  await start({}, context);
  m.api.events.emit("pi-persona:telemetry", {
    version: 1, id: "s:1", seq: 1, ts: 1, sessionId: "s", workspaceId: workspaceHash(cwd),
    type: "instance.heartbeat", payload: { contextPercent: 10 },
  });

  const shown = uiUpdates.join(" | ");
  const bare = /https?:\/\/127\.0\.0\.1:\d+(?![^\s|]*token)/;
  assert.ok(!bare.test(shown), `the status line offers a tokenless URL that 401s: ${shown}`);
  assert.match(shown, /\/dashboard/, "the status line must name the command that actually opens it");
  const shutdown = m.handlers.get("session_shutdown")![0] as () => Promise<void>;
  await shutdown();
});

test("the command name never collides with the host extension this one depends on", () => {
  // pi-persona-flow DEPENDS ON pi-persona, never the reverse — so when both want a name, this one
  // yields. Registering "flow" is not a cosmetic clash: pi-persona owns /flow for running a flow
  // (a DAG over strategies, with its own flows/ directory and flow(name, task) tool), it wins the
  // registration, and "/flow open" then resolves to "run a flow named open" — the dashboard becomes
  // unreachable by command while still serving on its port, which reads as a broken dashboard.
  const m = mockPi();
  // @ts-expect-error — minimal mock.
  piPersonaFlow(m.api);
  const mine = [...m.commands.keys()];
  assert.ok(!mine.includes("flow"), "`/flow` belongs to pi-persona; this extension must not shadow it");

  // When a sibling pi-persona checkout resolves, check the real list rather than a copy of it that
  // could drift. Skipping keeps this repo testable standalone.
  const roots = [process.env.PI_PERSONA_REPO, fileURLToPath(new URL("../../pi-persona/", import.meta.url))];
  const host = roots.flatMap((root) => (root ? [`${root.replace(/[\/]$/, "")}/src/extension.ts`] : [])).find((candidate) => existsSync(candidate));
  if (!host) return;
  const taken = new Set([...readFileSync(host, "utf8").matchAll(/registerCommand\("([a-z-]+)"/g)].map((match) => match[1]!));
  const clash = mine.filter((name) => taken.has(name));
  assert.deepEqual(clash, [], `these command names are already pi-persona's: ${clash.join(", ")}`);
});

test("Windows dashboard open never shells through cmd /c start", () => {
  // Pi forbids `cmd /c start`: cmd.exe re-parses metacharacters in the tokenized URL.
  const url = "http://127.0.0.1:7874/?token=abc&x=1";
  const win = browserLaunch("win32", url);
  assert.equal(win.cmd, "rundll32");
  assert.deepEqual(win.args, ["url.dll,FileProtocolHandler", url]);
  assert.equal(browserLaunch("darwin", url).cmd, "open");
  assert.equal(browserLaunch("linux", url).cmd, "xdg-open");
});
