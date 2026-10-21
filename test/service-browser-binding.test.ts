import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CONTROL_TOKEN_HEADER, SERVICE_DIRECTORY, SERVICE_DESCRIPTOR_FILE, type SharedServiceDescriptor } from "../shared/workspaces.ts";
import { connectFlowService } from "../src/service/client.ts";
import { readBrowserBinding, writeBrowserBinding } from "../src/service/browser-binding.ts";
import { createFixtureScope } from "./setup/fixture-scope.ts";
import { waitForServiceIdle } from "./setup/service-cleanup.ts";

test("browser bindings preserve only the public capability and honor changed port preferences", async () => {
  const scope = createFixtureScope();
  const directory = scope.tempDirectory("flow-browser-binding-parser-");
  try {
    assert.equal(await readBrowserBinding(directory, 0), undefined);
    await writeBrowserBinding(directory, 0, "http://127.0.0.1:8123/?token=Ab12");
    assert.deepEqual(await readBrowserBinding(directory, 0), { port: 8123, token: "Ab12" });
    assert.equal(await readBrowserBinding(directory, 9000), undefined, "a new desired port must take effect on the next daemon");
    const saved = JSON.parse(await readFile(join(directory, "browser.json"), "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), ["desiredPort", "url", "version"]);
  } finally { await scope.cleanup(); }
});

test("malformed, oversized and non-loopback browser bindings are rejected without replacement", async () => {
  const scope = createFixtureScope();
  const directory = scope.tempDirectory("flow-browser-binding-invalid-");
  const file = join(directory, "browser.json");
  try {
    for (const contents of ["invalid", "x".repeat(1025), JSON.stringify({ version: 1, desiredPort: 0, url: ["http://127.0.0.1:8123/?token=Ab12"] }),
      ...["http://example.com:8123/?token=Ab12", "http://127.0.0.1:0/?token=Ab12", "http://127.0.0.1:8123/?token=Ab12&token=Cd34", "http://127.0.0.1:8123/?token=secret", "http://user@127.0.0.1:8123/?token=Ab12"]
        .map((url) => JSON.stringify({ version: 1, desiredPort: 0, url })),
    ]) {
      await writeFile(file, contents);
      await assert.rejects(readBrowserBinding(directory, 0), /Flow browser binding/);
      assert.equal(await readFile(file, "utf8"), contents);
    }
  } finally { await scope.cleanup(); }
});

test("native service replacement preserves the browser binding while rotating private credentials", async () => {
  const scope = createFixtureScope();
  const root = scope.tempDirectory("flow-browser-binding-");
  const agentDir = join(root, "agent");
  const clients: Awaited<ReturnType<typeof connectFlowService>>[] = [];
  const ownedPids = new Set<number>();
  const descriptorPath = join(agentDir, SERVICE_DIRECTORY, SERVICE_DESCRIPTOR_FILE);
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  try {
    await mkdir(agentDir, { recursive: true });
    const first = await connectFlowService({ agentDir, cwd: root, sessionId: "first", port: 0, idleMs: 1_000 });
    clients.push(first);
    const before = JSON.parse(await readFile(descriptorPath, "utf8")) as SharedServiceDescriptor;
    ownedPids.add(before.pid);
    await first.close();
    await waitForServiceIdle(agentDir);

    const second = await connectFlowService({ agentDir, cwd: root, sessionId: "second", port: 0, idleMs: 1_000 });
    clients.push(second);
    const after = JSON.parse(await readFile(descriptorPath, "utf8")) as SharedServiceDescriptor;
    ownedPids.add(after.pid);
    assert.equal(second.url, first.url, "an existing browser tab must keep its origin and read-only launch code");
    assert.notEqual(after.serviceId, before.serviceId);
    assert.notEqual(after.controlToken, before.controlToken, "private control credentials must rotate independently");
    const oldBrowser = new URL(first.url); oldBrowser.pathname = "/api/workspaces";
    assert.equal((await fetch(oldBrowser)).status, 200, "the original browser URL must authenticate after replacement");
    const privateStatus = new URL("/internal/status", second.url);
    assert.equal((await fetch(privateStatus, { headers: { [CONTROL_TOKEN_HEADER]: before.controlToken } })).status, 401);
    const binding = await readFile(join(agentDir, SERVICE_DIRECTORY, "browser.json"), "utf8");
    assert.ok(!binding.includes(before.controlToken) && !binding.includes(after.controlToken));
  } finally {
    try {
      for (const client of clients) await client.close().catch(() => undefined);
      await waitForServiceIdle(agentDir);
    } catch (error) {
      // Only fixture descriptors establish ownership; join exact daemons before deleting a profile.
      const current = await readFile(descriptorPath, "utf8").then((raw) => JSON.parse(raw) as SharedServiceDescriptor).catch(() => undefined);
      if (current) ownedPids.add(current.pid);
      for (const pid of ownedPids) { if (alive(pid)) process.kill(pid, "SIGKILL"); }
      const deadline = Date.now() + 5_000;
      while ([...ownedPids].some(alive)) {
        assert.ok(Date.now() < deadline, "the exact fixture daemons must exit before cleanup");
        await new Promise((done) => setTimeout(done, 25));
      }
      throw error;
    } finally { if (![...ownedPids].some(alive)) await scope.cleanup(); }
  }
});
