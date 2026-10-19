import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SERVICE_DESCRIPTOR_FILE, SERVICE_DIRECTORY } from "../../shared/workspaces.ts";

/** Join our isolated daemon's idle shutdown before deleting its profile (Windows CWD locks). */
export async function waitForServiceIdle(agentDir: string): Promise<void> {
  const descriptor = join(agentDir, SERVICE_DIRECTORY, SERVICE_DESCRIPTOR_FILE);
  const deadline = Date.now() + 8_000;
  let pid: number | undefined;
  for (;;) {
    let exists = false;
    try { const parsed = JSON.parse(await readFile(descriptor, "utf8")) as { pid?: number }; pid = parsed.pid; exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let alive = false;
    if (pid !== undefined) {
      try { process.kill(pid, 0); alive = true; }
      catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    }
    if (!exists && !alive) return;
    assert.ok(Date.now() < deadline, "isolated Flow service did not finish idle shutdown");
    await new Promise((done) => setTimeout(done, 25));
  }
}
