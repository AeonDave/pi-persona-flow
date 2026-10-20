import assert from "node:assert/strict";
import { test } from "node:test";

import { createIdleShutdownPolicy } from "../src/service/idle-shutdown.ts";

test("a short desired idle window cannot expire before the first client startup grace", () => {
	const policy = createIdleShutdownPolicy(50, 15_000, 1_000);
	assert.equal(policy.shouldClose(1_050, 0, 0), false);
	assert.equal(policy.shouldClose(15_999, 0, 0), false);
	assert.equal(policy.shouldClose(16_000, 0, 0), true, "an abandoned startup still exits at its bounded grace");
});

test("after the first client is active, the configured idle window starts when all clients leave", () => {
	const policy = createIdleShutdownPolicy(50, 15_000, 1_000);
	assert.equal(policy.shouldClose(12_000, 1, 0), false, "a registered Pi client prevents shutdown");
	assert.equal(policy.shouldClose(12_010, 0, 0), false, "the first quiet sample starts the desired idle window");
	assert.equal(policy.shouldClose(12_059, 0, 0), false);
	assert.equal(policy.shouldClose(12_060, 0, 0), true);
});

test("an authenticated browser stream prevents shutdown and receives the idle window after disconnect", () => {
	const policy = createIdleShutdownPolicy(50, 15_000, 1_000);
	assert.equal(policy.shouldClose(30_000, 0, 1), false);
	assert.equal(policy.shouldClose(30_001, 0, 0), false);
	assert.equal(policy.shouldClose(30_050, 0, 0), false);
	assert.equal(policy.shouldClose(30_051, 0, 0), true);
});
