import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { DEFAULT_FLOW_SETTINGS, readFlowSettings, resolveFlowSettings } from "../src/settings.ts";

test("Flow settings resolve valid saved preferences with bounded defaults", () => {
	assert.deepEqual(resolveFlowSettings({ flowEnabled: false, flowPort: 0, flowIdleMs: 50 }, {}), {
		flowEnabled: false,
		flowPort: 0,
		flowIdleMs: 50,
	});
	assert.deepEqual(resolveFlowSettings({ flowEnabled: "false", flowPort: 65_536, flowIdleMs: 49 }, {}), DEFAULT_FLOW_SETTINGS);
	assert.deepEqual(resolveFlowSettings({ flowEnabled: true, otherPreference: "ignored" }, {}), {
		...DEFAULT_FLOW_SETTINGS,
		flowEnabled: true,
	});
});

test("existing Flow environment overrides win using the extension's current parsing rules", () => {
	const saved = { flowEnabled: false, flowPort: 8200, flowIdleMs: 4_000 };
	assert.deepEqual(resolveFlowSettings(saved, {
		PI_PERSONA_FLOW_PORT: "0",
		PI_PERSONA_FLOW_IDLE_MS: "2500",
	}), { flowEnabled: false, flowPort: 0, flowIdleMs: 2_500 });
	assert.deepEqual(resolveFlowSettings(saved, {
		PI_PERSONA_FLOW_PORT: " 8201 ",
		PI_PERSONA_FLOW_IDLE_MS: "2500ms",
	}), { flowEnabled: false, flowPort: 7_874, flowIdleMs: 60_000 });
});

test("readFlowSettings reads only version-1 preferences and never treats legacy files as active", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-flow-settings-"));
	const agentDir = join(root, "agent");
	try {
		const personaDir = join(agentDir, "persona");
		await mkdir(personaDir, { recursive: true });
		await writeFile(join(personaDir, "config.json"), JSON.stringify({ flowPort: 8111 }), "utf8");
		await writeFile(join(personaDir, "settings.json"), JSON.stringify({
			version: 1,
			preferences: { flowEnabled: false, flowPort: 8112, flowIdleMs: 750 },
			personas: { dev: { models: { reviewer: "provider/model" } } },
			lastPersona: "dev",
		}), "utf8");
		assert.deepEqual(readFlowSettings(agentDir, {}), { flowEnabled: false, flowPort: 8_112, flowIdleMs: 750 });
		await writeFile(join(personaDir, "settings.json"), JSON.stringify({ version: 2, preferences: { flowEnabled: false } }), "utf8");
		assert.deepEqual(readFlowSettings(agentDir, {}), DEFAULT_FLOW_SETTINGS);
	} finally {
		assert.equal(dirname(resolve(root)), resolve(tmpdir()));
		assert.ok(basename(root).startsWith("pi-flow-settings-"));
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("canonical settings accept UTF-8 BOM and CRLF without modifying the shared bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-flow-settings-bom-"));
	const file = join(root, "agent", "persona", "settings.json");
	try {
		await mkdir(dirname(file), { recursive: true });
		const bytes = Buffer.from("\uFEFF{\r\n  \"version\": 1,\r\n  \"preferences\": { \"flowPort\": 8211, \"flowIdleMs\": 1250 }\r\n}\r\n", "utf8");
		await writeFile(file, bytes);
		const warnings: string[] = [];
		assert.deepEqual(readFlowSettings(join(root, "agent"), {}, warnings), {
			...DEFAULT_FLOW_SETTINGS,
			flowPort: 8_211,
			flowIdleMs: 1_250,
		});
		assert.deepEqual(warnings, []);
		assert.deepEqual(await readFile(file), bytes);
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("oversized, malformed, and unreadable canonical settings warn and preserve source bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-flow-settings-invalid-"));
	const personaDir = join(root, "agent", "persona");
	const file = join(personaDir, "settings.json");
	try {
		await mkdir(personaDir, { recursive: true });
		const oversized = Buffer.alloc(1_048_577, 0x20);
		await writeFile(file, oversized);
		let warnings: string[] = [];
		assert.deepEqual(readFlowSettings(join(root, "agent"), {}, warnings), DEFAULT_FLOW_SETTINGS);
		assert.match(warnings.join(" "), /read limit/);
		assert.deepEqual(await readFile(file), oversized);

		const malformed = Buffer.from("{ definitely not json }\r\n", "utf8");
		await writeFile(file, malformed);
		warnings = [];
		assert.deepEqual(readFlowSettings(join(root, "agent"), {}, warnings), DEFAULT_FLOW_SETTINGS);
		assert.match(warnings.join(" "), /malformed/);
		assert.deepEqual(await readFile(file), malformed);

		const badParent = join(root, "not-a-directory");
		await writeFile(badParent, "unchanged");
		warnings = [];
		assert.deepEqual(readFlowSettings(badParent, {}, warnings), DEFAULT_FLOW_SETTINGS);
		assert.match(warnings.join(" "), /invalid parent/);
		assert.equal(await readFile(badParent, "utf8"), "unchanged");
	} finally {
		assert.equal(dirname(resolve(root)), resolve(tmpdir()));
		assert.ok(basename(root).startsWith("pi-flow-settings-invalid-"));
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("invalid known preferences and environment fields are reported while bounded defaults remain", () => {
	const warnings: string[] = [];
	assert.deepEqual(resolveFlowSettings({ flowEnabled: "false", flowPort: -1, flowIdleMs: 1 }, {
		PI_PERSONA_FLOW_PORT: " 8200 ",
		PI_PERSONA_FLOW_IDLE_MS: "100ms",
	}, warnings), DEFAULT_FLOW_SETTINGS);
	assert.equal(warnings.length, 5);
});
