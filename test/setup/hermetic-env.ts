/** A developer's Pi settings must never reconfigure test registration or start a dashboard. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
	if (key.toUpperCase() === "PI_AGENT_DIR" || key.toUpperCase().startsWith("PI_PERSONA_")) delete process.env[key];
}
const agentDir = mkdtempSync(join(tmpdir(), "pi-flow-test-agent-"));
process.env.PI_AGENT_DIR = agentDir;
process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));
