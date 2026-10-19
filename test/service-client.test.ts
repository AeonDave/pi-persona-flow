import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

import {
	SERVICE_DESCRIPTOR_FILE,
	SERVICE_DIRECTORY,
	SERVICE_START_LOCK_FILE,
	type SharedServiceDescriptor,
} from "../shared/workspaces.ts";
import { connectFlowService } from "../src/service/client.ts";

// Leave enough time for a cold native Node daemon to publish its descriptor and authenticate its
// first Pi attachment before the intentionally short test-only idle lease can retire it.
const IDLE_MS_FOR_TESTS = "1500";

async function temporaryAgentDir(): Promise<{ root: string; agentDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-flow-service-client-"));
	const agentDir = join(root, "isolated pi profile");
	await mkdir(agentDir, { recursive: true });
	return { root, agentDir };
}

async function removeTemporaryRoot(root: string): Promise<void> {
	const target = resolve(root);
	assert.equal(dirname(target), resolve(tmpdir()), `Refusing to remove a non-temp test path: ${target}`);
	assert.ok(basename(target).startsWith("pi-flow-service-client-"), `Unexpected temporary test root: ${target}`);
	await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => error ? rejectClose(error) : resolveClose());
	});
}

function descriptorPath(agentDir: string): string {
	return join(agentDir, SERVICE_DIRECTORY, SERVICE_DESCRIPTOR_FILE);
}

function serviceLockPath(agentDir: string): string {
	return join(agentDir, SERVICE_DIRECTORY, SERVICE_START_LOCK_FILE);
}

async function readDescriptor(agentDir: string): Promise<SharedServiceDescriptor> {
	return JSON.parse(await readFile(descriptorPath(agentDir), "utf8")) as SharedServiceDescriptor;
}

async function waitUntil(predicate: () => Promise<boolean>, description: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	do {
		if (await predicate()) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	} while (Date.now() < deadline);
	assert.fail(`Timed out waiting for ${description}`);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function publicCatalog(url: string): Promise<{ workspaces: Array<Record<string, unknown>> }> {
	const endpoint = new URL(url);
	endpoint.pathname = "/api/workspaces";
	const response = await fetch(endpoint);
	assert.equal(response.status, 200, `Authenticated workspace catalog returned HTTP ${response.status}`);
	return await response.json() as { workspaces: Array<Record<string, unknown>> };
}

async function setShortIdle<T>(callback: () => Promise<T>): Promise<T> {
	const previous = process.env.PI_PERSONA_FLOW_IDLE_MS;
	process.env.PI_PERSONA_FLOW_IDLE_MS = IDLE_MS_FOR_TESTS;
	try {
		return await callback();
	} finally {
		if (previous === undefined) delete process.env.PI_PERSONA_FLOW_IDLE_MS;
		else process.env.PI_PERSONA_FLOW_IDLE_MS = previous;
	}
}

test("parallel Pi attachments share one service, preserve workspace registrations, and detach independently", async () => {
	const { root, agentDir } = await temporaryAgentDir();
	const attachments: Awaited<ReturnType<typeof connectFlowService>>[] = [];
	let descriptor: SharedServiceDescriptor | undefined;
	try {
		await setShortIdle(async () => {
			const connections = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
				const cwd = join(root, "workspaces", `workspace-${index}`);
				await mkdir(cwd, { recursive: true });
				const connection = await connectFlowService({
					agentDir,
					cwd,
					sessionId: `qualification-session-${index}`,
					port: 0,
				});
				attachments.push(connection);
				return connection;
			}));
			descriptor = await readDescriptor(agentDir);

			assert.equal(new Set(connections.map((connection) => connection.url)).size, 1, "Concurrent Pi attachments launched more than one URL/service");
			assert.equal(new Set(connections.map((connection) => connection.workspaceId)).size, 10, "Independent workspaces were not kept distinct");
			assert.ok(connections.every((connection) => new URL(connection.url).origin === new URL(descriptor!.url).origin), "A client did not attach to the authenticated shared descriptor");
			assert.equal(descriptor.protocol, 1);
			assert.match(descriptor.controlToken, /^[A-Za-z0-9_-]{43}$/, "The private control token is not 256-bit material");
			assert.ok(processIsAlive(descriptor.pid), "The detached service process was not alive after attachment");

			const catalog = await publicCatalog(connections[0]!.url);
			assert.equal(catalog.workspaces.length, 10, "The shared catalog did not retain all concurrent workspaces");
			assert.ok(catalog.workspaces.every((workspace) => workspace.activeSessions === 1), "Active workspace session counts are incorrect");
			assert.ok(catalog.workspaces.every((workspace) => typeof workspace.label === "string" && !String(workspace.label).includes(root)), "A workspace label exposed its absolute path");
			assert.ok(!JSON.stringify(catalog).includes(descriptor.controlToken), "The browser catalog leaked the private control token");
			assert.ok(!JSON.stringify(catalog).includes(agentDir), "The browser catalog leaked the Pi profile path");

			const event = {
				version: 2,
				producerId: "service-client-qualification",
				producerVersion: "1",
				id: "service-client-qualification.started",
				seq: 1,
				ts: Date.now(),
				sessionId: "qualification-session-0",
				workspaceId: connections[0]!.workspaceId,
				type: "instance.started",
				payload: { displayName: "Local qualification", status: "active" },
			};
			await connections[0]!.publish([event]);

			await connections[0]!.close();
			await connections[0]!.close();
			const afterFirstClose = await publicCatalog(connections[1]!.url);
			assert.equal(afterFirstClose.workspaces.find((workspace) => workspace.id === connections[0]!.workspaceId)?.activeSessions, 0, "Closing one attachment did not unregister only that workspace client");
			assert.equal(afterFirstClose.workspaces.find((workspace) => workspace.id === connections[1]!.workspaceId)?.activeSessions, 1, "Closing one Pi attachment detached another Pi's workspace");
			await connections[1]!.heartbeat();

			const health = new URL(connections[1]!.url);
			health.pathname = "/health";
			assert.equal((await fetch(health)).status, 200, "The shared service died when its first client detached");

			for (const connection of connections.slice(1)) await connection.close();
			await waitUntil(async () => {
				try { await readFile(descriptorPath(agentDir)); return false; }
				catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
			}, "the idle shared service to remove its own descriptor");
			await waitUntil(async () => !processIsAlive(descriptor!.pid), "the idle shared service process to exit");
		});
	} finally {
		for (const attachment of attachments) await attachment.close().catch(() => undefined);
		if (!descriptor) descriptor = await readDescriptor(agentDir).catch(() => undefined);
		if (descriptor && processIsAlive(descriptor.pid)) {
			await waitUntil(async () => !processIsAlive(descriptor!.pid), "the test service to finish its idle lifecycle");
		}
		await removeTemporaryRoot(root);
	}
});

test("cancellation while another live Pi owns startup does not remove its lock or register", async () => {
	const { root, agentDir } = await temporaryAgentDir();
	const lock = serviceLockPath(agentDir);
	const owner = { pid: process.pid, nonce: "a11c0c0ffeebaddecafefeed12345678" };
	await mkdir(join(agentDir, SERVICE_DIRECTORY), { recursive: true });
	await writeFile(lock, JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
	const controller = new AbortController();
	let descriptor: SharedServiceDescriptor | undefined;
	try {
		await setShortIdle(async () => {
			const attach = connectFlowService({ agentDir, cwd: root, sessionId: "cancelled-attach", port: 0, signal: controller.signal });
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
			controller.abort();
			await assert.rejects(attach, { name: "AbortError" });
			assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), owner, "A cancelled contender deleted another live Pi's startup lock");
			await assert.rejects(readFile(descriptorPath(agentDir)), { code: "ENOENT" }, "A cancelled attachment unexpectedly started a service");
		});
	} finally {
		descriptor = await readDescriptor(agentDir).catch(() => undefined);
		if (descriptor && processIsAlive(descriptor.pid)) await waitUntil(async () => !processIsAlive(descriptor!.pid), "cancelled test service to exit");
		await removeTemporaryRoot(root);
	}
});

test("a malformed startup owner fails closed without overwriting operator data", async () => {
	const { root, agentDir } = await temporaryAgentDir();
	const lock = serviceLockPath(agentDir);
	const malformed = "{not-json";
	await mkdir(join(agentDir, SERVICE_DIRECTORY), { recursive: true });
	await writeFile(lock, malformed, "utf8");
	let descriptor: SharedServiceDescriptor | undefined;
	try {
		await setShortIdle(async () => {
			await assert.rejects(
				connectFlowService({ agentDir, cwd: root, sessionId: "malformed-owner", port: 0 }),
				/startup lock.*(malformed|invalid|owner)/i,
			);
			assert.equal(await readFile(lock, "utf8"), malformed, "The client removed an unknown/malformed lock it could not prove stale");
			await assert.rejects(readFile(descriptorPath(agentDir)), { code: "ENOENT" }, "A malformed lock triggered an uncoordinated daemon launch");
		});
	} finally {
		descriptor = await readDescriptor(agentDir).catch(() => undefined);
		if (descriptor && processIsAlive(descriptor.pid)) await waitUntil(async () => !processIsAlive(descriptor!.pid), "malformed-lock test service to exit");
		await removeTemporaryRoot(root);
	}
});

test("a lock owned by a proven-dead PID is reclaimed before launch", async () => {
	const { root, agentDir } = await temporaryAgentDir();
	const lock = serviceLockPath(agentDir);
	const deadOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
	await once(deadOwner, "spawn");
	const deadPid = deadOwner.pid;
	assert.ok(deadPid, "The stale-owner fixture process did not start");
	deadOwner.kill();
	await once(deadOwner, "exit");
	await mkdir(join(agentDir, SERVICE_DIRECTORY), { recursive: true });
	await writeFile(lock, JSON.stringify({ pid: deadPid, nonce: "deadbeefdeadbeefdeadbeefdeadbeef" }), { encoding: "utf8", mode: 0o600 });
	let attachment: Awaited<ReturnType<typeof connectFlowService>> | undefined;
	let descriptor: SharedServiceDescriptor | undefined;
	try {
		await setShortIdle(async () => {
			attachment = await connectFlowService({ agentDir, cwd: root, sessionId: "recovered-attach", port: 0 });
			descriptor = await readDescriptor(agentDir);
			assert.ok(processIsAlive(descriptor.pid), "The stale-owner recovery did not start a service");
			assert.notEqual(descriptor.pid, deadPid, "The descriptor still names the proven-dead startup owner");
			await attachment.close();
			await waitUntil(async () => {
				try { await readFile(descriptorPath(agentDir)); return false; }
				catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
			}, "the recovered service's idle cleanup");
		});
	} finally {
		await attachment?.close().catch(() => undefined);
		if (descriptor && processIsAlive(descriptor.pid)) await waitUntil(async () => !processIsAlive(descriptor!.pid), "the recovered service to exit");
		await removeTemporaryRoot(root);
	}
});

test("a proven-dead reclaim owner fails closed with an actionable recovery path", async () => {
	const { root, agentDir } = await temporaryAgentDir();
	const lock = serviceLockPath(agentDir);
	const reclaim = `${lock}.reclaim`;
	const deadOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
	await once(deadOwner, "spawn");
	const deadPid = deadOwner.pid;
	assert.ok(deadPid, "The stale-reclaimer fixture process did not start");
	deadOwner.kill();
	await once(deadOwner, "exit");
	const startupOwner = { pid: deadPid, nonce: "deadbeefdeadbeefdeadbeefdeadbeef" };
	const reclaimOwner = { pid: deadPid, nonce: "a11c0c0ffeebaddecafefeed12345678" };
	await mkdir(join(agentDir, SERVICE_DIRECTORY), { recursive: true });
	await writeFile(lock, JSON.stringify(startupOwner), { encoding: "utf8", mode: 0o600 });
	await writeFile(reclaim, JSON.stringify(reclaimOwner), { encoding: "utf8", mode: 0o600 });
	try {
		await setShortIdle(async () => {
			await assert.rejects(
				connectFlowService({ agentDir, cwd: root, sessionId: "stale-reclaimer", port: 0 }),
				/confirming no Flow daemon or live Pi uses this profile.*remove only this stale reclaim lock and retry/i,
			);
			assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), startupOwner, "The unsafe recovery removed the original startup lock");
			assert.deepEqual(JSON.parse(await readFile(reclaim, "utf8")), reclaimOwner, "The unsafe recovery deleted a reclaim lock without ownership proof");
			await assert.rejects(readFile(descriptorPath(agentDir)), { code: "ENOENT" }, "A dead reclaimer triggered an uncoordinated service launch");
		});
	} finally {
		await removeTemporaryRoot(root);
	}
});

test("private control requests reject redirects before credentials can leave the descriptor origin", async () => {
	const { root, agentDir } = await temporaryAgentDir();
	let redirectedRequests = 0;
	const destination = createServer((_request, response) => {
		redirectedRequests += 1;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ protocol: 1, serviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: "ignored" }));
	});
	const destinationUrl = await listen(destination);
	const origin = createServer((_request, response) => {
		response.writeHead(302, { location: `${destinationUrl}/internal/status` });
		response.end();
	});
	const originUrl = await listen(origin);
	const descriptor: SharedServiceDescriptor = {
		protocol: 1,
		serviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		pid: process.pid,
		url: `${originUrl}/?token=Ab0T`,
		controlToken: "A".repeat(43),
		startedAt: Date.now(),
	};
	await mkdir(join(agentDir, SERVICE_DIRECTORY), { recursive: true });
	await writeFile(descriptorPath(agentDir), JSON.stringify(descriptor), { encoding: "utf8", mode: 0o600 });
	const controller = new AbortController();
	try {
		const attaching = connectFlowService({ agentDir, cwd: root, sessionId: "redirect-guard", port: 0, signal: controller.signal });
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		controller.abort();
		await assert.rejects(attaching, { name: "AbortError" });
		assert.equal(redirectedRequests, 0, "The private control token followed a descriptor-origin redirect");
	} finally {
		await closeServer(origin);
		await closeServer(destination);
		await removeTemporaryRoot(root);
	}
});
