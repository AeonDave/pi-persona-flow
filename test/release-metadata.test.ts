import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function json(relative: string) {
	return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
}

test("the dashboard qualifies Pi 1.0 and ships its web UI without host copies", () => {
	const manifest = json("../package.json");
	const lock = json("../package-lock.json");
	assert.equal(manifest.engines.node, ">=22.19.0");
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[""].version, manifest.version);
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependenciesMeta["@earendil-works/pi-coding-agent"].optional, true);
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "1.0.0");
  for (const host of ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) assert.equal(manifest.devDependencies[`@earendil-works/${host}`], "1.0.0");
	assert.equal(manifest.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
	assert.deepEqual(manifest.pi.extensions, ["./src/extension.ts"]);
	assert.ok(manifest.files.includes("dist/web"));
	assert.match(manifest.scripts.test, /--import \.\/test\/setup\/hermetic-env\.ts/);
});

test("CI covers all desktop platforms with audit, backend, frontend and build gates", () => {
	const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
	const actions = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s]+)/g)];
	assert.ok(actions.length >= 2);
	for (const action of actions) assert.match(action[1]!, /^[a-f0-9]{40}$/);
	for (const platform of ["ubuntu-latest", "windows-latest", "macos-latest"]) assert.ok(workflow.includes(platform));
	assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: 22\.19\.0/);
	for (const command of ["npm audit --audit-level=low", "npm --prefix web audit --audit-level=low", "npm run typecheck:all", "npm run test:all", "npm run build"]) assert.ok(workflow.includes(command));
});
