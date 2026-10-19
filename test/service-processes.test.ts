import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
	SERVICE_DESCRIPTOR_FILE,
	SERVICE_DIRECTORY,
	type SharedServiceDescriptor,
} from "../shared/workspaces.ts";
import { waitForServiceIdle } from "./setup/service-cleanup.ts";

const CLIENT_COUNT = 10;
const CLIENTS_PER_WORKSPACE = CLIENT_COUNT / 2;
const CLIENT_IDLE_MS = "4000";
const MAX_OUTPUT_BYTES = 16 * 1024;
const CLIENT_FIXTURE = fileURLToPath(new URL("./fixtures/service-process.ts", import.meta.url));

interface ClientMessage {
	type: "connected" | "closed";
	pid?: number;
	sessionId?: string;
	url?: string;
	workspaceId?: string;
}

interface ClientWaiter {
	type: ClientMessage["type"];
	timer: ReturnType<typeof setTimeout>;
	resolve(message: ClientMessage): void;
	reject(error: Error): void;
}

interface ProcessClient {
	child: ChildProcess;
	pid: number;
	waitForMessage(type: ClientMessage["type"], timeoutMs: number): Promise<ClientMessage>;
	waitForExit(timeoutMs: number): Promise<void>;
	isClosed(): boolean;
}

function processIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function descriptorPath(agentDir: string): string {
	return join(agentDir, SERVICE_DIRECTORY, SERVICE_DESCRIPTOR_FILE);
}

function isolatedChildEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.PI_PERSONA_FLOW_IDLE_MS = CLIENT_IDLE_MS;
	return env;
}

async function temporaryRoot(): Promise<{ root: string; agentDir: string; workspaces: [string, string] }> {
	const root = await mkdtemp(join(tmpdir(), "pi-flow-service-processes-"));
	const agentDir = join(root, "isolated pi profile");
	const workspaces: [string, string] = [join(root, "workspaces", "alpha space"), join(root, "workspaces", "beta space")];
	await Promise.all([agentDir, ...workspaces].map((directory) => mkdir(directory, { recursive: true })));
	return { root, agentDir, workspaces };
}

async function removeTemporaryRoot(root: string): Promise<void> {
	const target = resolve(root);
	assert.equal(dirname(target), resolve(tmpdir()), `Refusing to remove a non-temp test path: ${target}`);
	assert.ok(basename(target).startsWith("pi-flow-service-processes-"), `Unexpected temporary test root: ${target}`);
	await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function launchClient(agentDir: string, cwd: string, sessionId: string): ProcessClient {
	const child = spawn(process.execPath, ["--experimental-strip-types", CLIENT_FIXTURE, agentDir, cwd, sessionId], {
		cwd,
		detached: false,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: isolatedChildEnvironment(),
	});
	let stdoutBuffer = "";
	let stderr = "";
	let outputBytes = 0;
	let exitCode: number | null | undefined;
	let exitSignal: NodeJS.Signals | null | undefined;
	let failure: Error | undefined;
	const messages: ClientMessage[] = [];
	const waiters: ClientWaiter[] = [];
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolveClosedPromise) => { resolveClosed = resolveClosedPromise; });
	const clientLabel = (): string => child.pid ? `Client ${child.pid}` : `Client ${sessionId}`;

	function fail(error: Error): void {
		failure ??= error;
		for (const waiter of waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(failure);
		}
		if (exitCode === undefined && child.pid) {
			try { child.kill(); } catch { /* the fixture may have exited concurrently */ }
		}
	}

	function parseLines(): void {
		while (true) {
			const newline = stdoutBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = stdoutBuffer.slice(0, newline).trim();
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			let message: ClientMessage;
			try { message = JSON.parse(line) as ClientMessage; }
			catch { fail(new Error(`${clientLabel()} emitted invalid JSON on stdout`)); return; }
			if (message.type !== "connected" && message.type !== "closed") {
				fail(new Error(`${clientLabel()} emitted an unexpected protocol message`));
				return;
			}
			const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
			if (waiterIndex >= 0) {
				const [waiter] = waiters.splice(waiterIndex, 1);
				if (waiter) { clearTimeout(waiter.timer); waiter.resolve(message); }
			} else {
				messages.push(message);
			}
		}
	}

	function assertSuccessfulExit(): void {
		if (exitCode !== 0) throw new Error(`${clientLabel()} exited (${String(exitCode)}, ${String(exitSignal)}): ${stderr.trim()}`);
	}

	child.once("error", (error) => fail(new Error(`${clientLabel()} failed to spawn or exited with an error: ${error.message}`)));
	child.once("close", (code, signal) => {
		exitCode = code;
		exitSignal = signal;
		resolveClosed();
		if (code !== 0 && !failure) failure = new Error(`${clientLabel()} exited (${String(code)}, ${String(signal)}): ${stderr.trim()}`);
		for (const waiter of waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(failure ?? new Error(`${clientLabel()} exited before its ${waiter.type} message`));
		}
	});
	child.stdout?.on("data", (chunk: Buffer | string) => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		outputBytes += Buffer.byteLength(text);
		if (outputBytes > MAX_OUTPUT_BYTES) { fail(new Error(`${clientLabel()} exceeded the bounded stdout budget`)); return; }
		stdoutBuffer += text;
		parseLines();
	});
	child.stderr?.on("data", (chunk: Buffer | string) => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		outputBytes += Buffer.byteLength(text);
		if (outputBytes > MAX_OUTPUT_BYTES) { fail(new Error(`${clientLabel()} exceeded the bounded combined output budget`)); return; }
		stderr += text;
	});
	child.stdin?.on("error", () => { /* a fixture may exit while the parent closes its input */ });
	child.stdout?.on("error", (error) => fail(new Error(`${clientLabel()} stdout failed: ${error.message}`)));
	child.stderr?.on("error", (error) => fail(new Error(`${clientLabel()} stderr failed: ${error.message}`)));

	return {
		child,
		get pid() { return child.pid ?? 0; },
		isClosed: () => exitCode !== undefined,
		waitForMessage(type, timeoutMs) {
			const index = messages.findIndex((message) => message.type === type);
			if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
			if (failure) return Promise.reject(failure);
			if (exitCode !== undefined) return Promise.reject(new Error(`${clientLabel()} exited (${String(exitCode)}, ${String(exitSignal)}) before its ${type} message: ${stderr.trim()}`));
			return new Promise((resolveMessage, rejectMessage) => {
				const waiter: ClientWaiter = {
					type,
					timer: setTimeout(() => {
						const waiterIndex = waiters.indexOf(waiter);
						if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
						rejectMessage(new Error(`Timed out after ${timeoutMs} ms waiting for ${clientLabel()} ${type}; stderr=${stderr.trim()}`));
					}, timeoutMs),
					resolve: resolveMessage,
					reject: rejectMessage,
				};
				waiters.push(waiter);
			});
		},
		async waitForExit(timeoutMs) {
			if (exitCode !== undefined) { assertSuccessfulExit(); return; }
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					closed,
					new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${clientLabel()} to exit`)), timeoutMs); }),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			assertSuccessfulExit();
		},
	};
}

async function shutdownClients(clients: readonly ProcessClient[]): Promise<Error[]> {
	const errors: Error[] = [];
	for (const client of clients) {
		if (!client.isClosed()) {
			try { client.child.stdin?.end(); }
			catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
		}
	}
	for (const client of clients) {
		if (client.isClosed()) continue;
		try { await client.waitForMessage("closed", 5_000); }
		catch { /* an already-failed fixture is handled by the bounded process-exit check below */ }
		try { await client.waitForExit(2_000); }
		catch {
			try { client.child.kill(); }
			catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
			try { await client.waitForExit(2_000); }
			catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
		}
	}
	return errors;
}

async function readDescriptor(agentDir: string): Promise<SharedServiceDescriptor> {
	return JSON.parse(await readFile(descriptorPath(agentDir), "utf8")) as SharedServiceDescriptor;
}

async function readCatalog(url: string): Promise<{ workspaces: Array<{ id: string; activeSessions: number }> }> {
	const endpoint = new URL(url);
	endpoint.pathname = "/api/workspaces";
	const response = await fetch(endpoint);
	assert.equal(response.status, 200, `Authenticated workspace catalog returned HTTP ${response.status}`);
	return await response.json() as { workspaces: Array<{ id: string; activeSessions: number }> };
}

test("ten independent native Node Pi clients share one daemon across two workspaces", async () => {
	const { root, agentDir, workspaces } = await temporaryRoot();
	const clients: ProcessClient[] = [];
	let failure: unknown;
	try {
		const launchInputs = Array.from({ length: CLIENT_COUNT }, (_, index) => ({
			cwd: workspaces[Math.floor(index / CLIENTS_PER_WORKSPACE)]!,
			sessionId: `native-process-session-${index}`,
		}));
		for (const input of launchInputs) clients.push(launchClient(agentDir, input.cwd, input.sessionId));

		const connected = await Promise.all(clients.map((client) => client.waitForMessage("connected", 20_000)));
		assert.equal(new Set(clients.map((client) => client.pid)).size, CLIENT_COUNT, "The harness did not create ten distinct client process IDs");
		assert.ok(connected.every((message, index) => message.pid === clients[index]?.pid), "A client did not report its actual child-process PID");
		assert.equal(new Set(connected.map((message) => message.url)).size, 1, "Independent processes did not converge on one stable dashboard URL");
		assert.equal(new Set(connected.map((message) => message.workspaceId)).size, 2, "The two filesystem workspaces were not kept distinct");
		assert.equal(new Set(connected.map((message) => message.sessionId)).size, CLIENT_COUNT, "Client sessions were not registered independently");

		const descriptor = await readDescriptor(agentDir);
		assert.equal(descriptor.protocol, 1);
		assert.equal(new Set(connected.map((message) => message.url)).size, 1);
		assert.equal(connected[0]?.url, descriptor.url, "Clients did not use the authenticated private descriptor's browser URL");
		assert.ok(processIsAlive(descriptor.pid), "The detached shared service is not alive after ten clients attached");
		assert.ok(!clients.some((client) => client.pid === descriptor.pid), "The service PID was confused with a Pi client PID");

		const initialCatalog = await readCatalog(descriptor.url);
		assert.equal(initialCatalog.workspaces.length, 2, "The service created an unexpected number of workspace stores");
		assert.deepEqual(initialCatalog.workspaces.map((workspace) => workspace.activeSessions).sort((a, b) => a - b), [5, 5], "Each workspace must contain five independently registered Pi processes");
		assert.deepEqual(new Set(initialCatalog.workspaces.map((workspace) => workspace.id)), new Set(connected.map((message) => message.workspaceId)));

		const firstClient = clients[0]!;
		firstClient.child.stdin?.end();
		await firstClient.waitForMessage("closed", 5_000);
		await firstClient.waitForExit(5_000);
		const afterFirstClose = await readCatalog(descriptor.url);
		assert.ok(processIsAlive(descriptor.pid), "Closing the first Pi client stopped the shared service for the other nine");
		assert.deepEqual(afterFirstClose.workspaces.map((workspace) => workspace.activeSessions).sort((a, b) => a - b), [4, 5], "Closing one client detached more than its own workspace lease");

		for (const client of clients.slice(1)) client.child.stdin?.end();
		await Promise.all(clients.slice(1).map((client) => client.waitForMessage("closed", 5_000)));
		await Promise.all(clients.slice(1).map((client) => client.waitForExit(5_000)));
		await waitForServiceIdle(agentDir);
		await assert.rejects(readFile(descriptorPath(agentDir)), { code: "ENOENT" }, "The idle daemon did not remove its private descriptor");
		assert.ok(!processIsAlive(descriptor.pid), "The shared service failed to exit after all independent clients detached");
	} catch (error) {
		failure = error;
	} finally {
		const cleanupErrors = await shutdownClients(clients);
		let serviceIdle = true;
		try { await waitForServiceIdle(agentDir); }
		catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); serviceIdle = false; }
		if (serviceIdle) {
			try { await removeTemporaryRoot(root); }
			catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
		} else {
			cleanupErrors.push(new Error(`Retained isolated profile until its service exits: ${root}`));
		}
		if (failure && cleanupErrors.length > 0) throw new AggregateError([failure, ...cleanupErrors], "Multiprocess Flow service test and cleanup both failed");
		if (!failure && cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Multiprocess Flow service cleanup failed");
	}
	if (failure) throw failure;
});
