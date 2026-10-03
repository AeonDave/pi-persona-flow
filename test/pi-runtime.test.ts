import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { workspaceHash } from "../src/tailer.ts";
import { runtimeHarness } from "./setup/pi-runtime.ts";

const entry = fileURLToPath(new URL("../src/extension.ts", import.meta.url));
type Harness = Awaited<ReturnType<typeof runtimeHarness>>;

function publish(h: Harness, seq: number, type: string, payload: Record<string, unknown>) {
  h.eventBus.emit("pi:telemetry", {
    version: 2, producerId: "offline.producer", producerVersion: "1.0.0", sessionId: "native",
    workspaceId: workspaceHash(h.cwd), id: `native:${seq}`, seq, ts: Date.now(), type, payload,
  });
}

test("real Pi 1.0: autostart, authenticated telemetry API, bounded UI updates and shutdown", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-runtime-"));
  const previousPort = process.env.PI_PERSONA_FLOW_PORT;
  process.env.PI_PERSONA_FLOW_PORT = "0";
  let h: Harness | undefined;
  try {
    h = await runtimeHarness(root, entry);
    h.session.extensionRunner!.setFlagValue("flow", true);
    await h.bind();
    const url = h.widgets.find((line) => line.startsWith("flow dashboard at "))?.slice("flow dashboard at ".length);
    assert.ok(url, "the loaded extension announces the actual authenticated URL");
    const endpoint = new URL(url);
    endpoint.pathname = "/api/snapshot";
    const withoutToken = new URL(endpoint);
    withoutToken.search = "";
    assert.equal((await fetch(withoutToken)).status, 401);
    publish(h, 1, "agent.added", { id: "run-9", label: "Dewglass", kind: "subagent", status: "waiting" });
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    const snapshot = await response.json() as { state: { agents: Record<string, { label: string; status: string }> } };
    assert.ok(Object.values(snapshot.state.agents).some((agent) => agent.label === "Dewglass" && agent.status === "waiting"));
    const before = h.statuses.length;
    for (let seq = 2; seq <= 101; seq += 1) publish(h, seq, "instance.heartbeat", { status: "active", contextPercent: seq % 100 });
    assert.equal(h.statuses.length, before, "unchanged footer must not schedule 100 redraws");
    const command = h.session.extensionRunner!.getCommand("dashboard");
    assert.ok(command);
    await command.handler("stop", h.session.extensionRunner!.createCommandContext());
    await assert.rejects(fetch(endpoint), /fetch failed/);
  } finally {
    await h?.dispose();
    if (previousPort === undefined) delete process.env.PI_PERSONA_FLOW_PORT;
    else process.env.PI_PERSONA_FLOW_PORT = previousPort;
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi 1.0: concurrent dashboard starts share one server and stop cancels a pending start", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-start-"));
  const previousPort = process.env.PI_PERSONA_FLOW_PORT;
  process.env.PI_PERSONA_FLOW_PORT = "0";
  let h: Harness | undefined;
  const announced: string[] = [];
  try {
    h = await runtimeHarness(root, entry);
    await h.bind();
    const runner = h.session.extensionRunner!;
    const command = runner.getCommand("dashboard")!;
    const context = runner.createCommandContext();
    // Unknown commands are a useful negative control: they must not allocate a listener.
    await command.handler("typo", context);
    assert.equal(h.widgets.length, 0, "unknown subcommands do not start a hidden server");
    await command.handler("status", context);
    assert.equal(h.notifications.at(-1), "flow dashboard stopped", "no listener was allocated silently");
    await Promise.all([command.handler("serve", context), command.handler("serve", context)]);
    announced.push(...h.widgets.map((line) => line.slice("flow dashboard at ".length)));
    assert.equal(new Set(announced).size, 1, "concurrent calls share one listener/token");
    await command.handler("stop", context);
    for (const url of announced) await assert.rejects(fetch(url), /fetch failed/);
    h.widgets.length = 0;
    const pending = command.handler("serve", context);
    await command.handler("stop", context);
    await pending;
    assert.equal(h.widgets.length, 0, "stop must prevent a late listening announcement");
  } finally {
    // Close every announced server even if the pre-fix implementation leaked one.
    await h?.dispose();
    if (previousPort === undefined) delete process.env.PI_PERSONA_FLOW_PORT;
    else process.env.PI_PERSONA_FLOW_PORT = previousPort;
    await rm(root, { recursive: true, force: true });
  }
});
