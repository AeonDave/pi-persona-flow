import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	CONTROL_TOKEN_HEADER,
	SERVICE_DESCRIPTOR_FILE,
	SERVICE_DIRECTORY,
	SERVICE_START_LOCK_FILE,
	SHARED_SERVICE_PROTOCOL,
	type SharedServiceDescriptor,
	type WorkspaceRegistration,
} from "../../shared/workspaces.ts";
import { workspaceHash } from "../tailer.ts";

const DEFAULT_PORT = 7_874;
const STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 50;
const CONTROL_REQUEST_TIMEOUT_MS = 1_000;
const MAX_CONTROL_BODY_BYTES = 16 * 1024;
const MAX_INGEST_BODY_BYTES = 2 * 1024 * 1024;
const RECLAIM_LOCK_SUFFIX = ".reclaim";
const ENTRY_PATH = fileURLToPath(new URL("./entry.ts", import.meta.url));

export interface ConnectFlowServiceOptions {
	agentDir: string;
	cwd: string;
	sessionId: string;
	port?: number;
	/** Desired idle window for a daemon started by this call; an existing service is never changed. */
	idleMs?: number;
	signal?: AbortSignal;
}

export interface FlowServiceClient {
	url: string;
	workspaceId: string;
	heartbeat(): Promise<void>;
	publish(events: readonly unknown[]): Promise<void>;
	close(): Promise<void>;
}

interface LockOwner {
	pid: number;
	nonce: string;
}

interface PrivateResponse {
	status: number;
	value: unknown;
}

interface ChildState {
	child: ChildProcess;
	exited: Promise<void>;
	error?: Error;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
}

/** Connect one Pi session to its per-profile shared Flow daemon, starting it if necessary. */
export async function connectFlowService(options: ConnectFlowServiceOptions): Promise<FlowServiceClient> {
	validateOptions(options);
	throwIfAborted(options.signal);
	const agentDir = path.resolve(options.agentDir);
	const cwd = path.resolve(options.cwd);
	const port = options.port ?? configuredPort();
	validatePort(port);
	const directory = path.join(agentDir, SERVICE_DIRECTORY);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const workspaceId = workspaceHash(cwd);
	const registration: WorkspaceRegistration = {
		clientId: randomUUID(),
		sessionId: options.sessionId,
		pid: process.pid,
		workspaceId,
		cwd,
		label: safeWorkspaceLabel(cwd),
	};
	const descriptor = await ensureService({
		directory,
		agentDir,
		port,
		...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	throwIfAborted(options.signal);
	try {
		const result = await registerClient(descriptor, registration, options.signal);
		throwIfAborted(options.signal);
		if (result.workspaceId !== workspaceId) throw new Error("Flow service registered an unexpected workspace identity");
	} catch (error) {
		// A request can be accepted just before its caller is cancelled. Best-effort unregister on
		// that path so a cancelled Pi attachment cannot leave an active workspace lease behind.
		await unregisterClient(descriptor, registration.clientId).catch(() => undefined);
		throw error;
	}

	let closed = false;
	let closePromise: Promise<void> | undefined;
	return {
		url: descriptor.url,
		workspaceId,
		heartbeat: async () => {
			if (closed) throw new Error("Flow client is closed");
			const response = await privateRequest(descriptor, "/internal/heartbeat", { clientId: registration.clientId });
			if (response.status === 404) {
				const registered = await registerClient(descriptor, registration);
				if (registered.workspaceId !== workspaceId) throw new Error("Flow service re-registered an unexpected workspace identity");
				return;
			}
			if (response.status !== 200) throw privateStatusError("heartbeat", response.status);
		},
		publish: async (events) => {
			if (closed) throw new Error("Flow client is closed");
			if (!Array.isArray(events)) throw new TypeError("Flow telemetry events must be an array");
			let body: string;
			try {
				body = JSON.stringify({ clientId: registration.clientId, events });
			} catch {
				throw new TypeError("Flow telemetry events must be JSON-serializable");
			}
			if (Buffer.byteLength(body) > MAX_INGEST_BODY_BYTES) throw new RangeError("Flow telemetry batch exceeds the 2 MiB service limit");
			const response = await privateRequest(descriptor, "/internal/ingest", undefined, body, MAX_INGEST_BODY_BYTES);
			if (response.status !== 200) throw privateStatusError("telemetry ingest", response.status);
		},
		close: () => {
			if (closePromise) return closePromise;
			closed = true;
			closePromise = unregisterClient(descriptor, registration.clientId).then(() => undefined);
			return closePromise;
		},
	};
}

function validateOptions(options: ConnectFlowServiceOptions): void {
	if (!path.isAbsolute(options.agentDir)) throw new TypeError("agentDir must be absolute");
	if (!path.isAbsolute(options.cwd)) throw new TypeError("cwd must be absolute");
	if (options.idleMs !== undefined && (!Number.isSafeInteger(options.idleMs) || options.idleMs < 50 || options.idleMs > 60_000)) {
		throw new RangeError("idleMs must be an integer from 50 to 60000");
	}
	if (typeof options.sessionId !== "string" || options.sessionId.length < 1 || options.sessionId.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(options.sessionId)) {
		throw new TypeError("sessionId must be a bounded non-empty string");
	}
}

function configuredPort(): number {
	const value = (process.env.PI_PERSONA_FLOW_PORT ?? "").trim();
	return /^\d+$/.test(value) ? Number(value) : DEFAULT_PORT;
}

function validatePort(port: number): void {
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError("port must be between 0 and 65535");
}

function safeWorkspaceLabel(cwd: string): string {
	const label = path.basename(cwd).normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f<>]/g, " ").replace(/\s+/g, " ").trim();
	return Array.from(label).slice(0, 80).join("") || "workspace";
}

async function ensureService(input: {
	directory: string;
	agentDir: string;
	port: number;
	idleMs?: number;
	signal?: AbortSignal;
}): Promise<SharedServiceDescriptor> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	const descriptorPath = path.join(input.directory, SERVICE_DESCRIPTOR_FILE);
	const lockPath = path.join(input.directory, SERVICE_START_LOCK_FILE);
	while (Date.now() < deadline) {
		throwIfAborted(input.signal);
		const descriptor = await readDescriptor(descriptorPath);
		if (descriptor && processIsAlive(descriptor.pid)) {
			const verified = await verifyDescriptor(descriptor, input.signal);
			if (verified === "ready") return descriptor;
			if (verified === "invalid") throw new Error("Flow service descriptor failed authenticated identity verification");
			await pause(input.signal, STARTUP_POLL_MS);
			continue;
		}

		const owner = { pid: process.pid, nonce: randomBytes(16).toString("hex") } satisfies LockOwner;
		if (await createExclusiveOwnerFile(lockPath, owner)) {
			try {
				return await startUnderLock(input, descriptorPath, deadline);
			} finally {
				await releaseOwnerFile(lockPath, owner);
			}
		}

		const currentOwner = await readOwnerFile(lockPath);
		if (!currentOwner) continue;
		if (currentOwner && processIsAlive(currentOwner.pid)) {
			await pause(input.signal, STARTUP_POLL_MS);
			continue;
		}
		await reclaimDeadOwner(lockPath, currentOwner, input.signal);
	}
	throwIfAborted(input.signal);
	throw new Error(`Timed out after ${STARTUP_TIMEOUT_MS} ms waiting for the authenticated Flow service`);
}

async function startUnderLock(
	input: { directory: string; agentDir: string; port: number; idleMs?: number; signal?: AbortSignal },
	descriptorPath: string,
	deadline: number,
): Promise<SharedServiceDescriptor> {
	throwIfAborted(input.signal);
	const existing = await readDescriptor(descriptorPath);
	if (existing) {
		if (processIsAlive(existing.pid)) {
			const verified = await verifyDescriptor(existing, input.signal);
			if (verified === "ready") return existing;
			throw new Error("Flow service is alive but its descriptor cannot be authenticated; refusing a second daemon");
		}
		await removeDescriptorIfSame(descriptorPath, existing);
	}

	const childState = spawnDaemon(input.agentDir, input.port, input.idleMs);
	try {
		while (Date.now() < deadline) {
			throwIfAborted(input.signal);
			if (childState.error) throw new Error(`Unable to spawn the Flow service: ${childState.error.message}`);
			if (childState.exitCode !== undefined) {
				throw new Error(`Flow service exited before publishing its descriptor (code ${String(childState.exitCode)}, signal ${String(childState.exitSignal)})`);
			}
			const descriptor = await readDescriptor(descriptorPath);
			if (descriptor) {
				const verified = await verifyDescriptor(descriptor, input.signal);
				if (verified === "ready") return descriptor;
				if (verified === "invalid") throw new Error("Flow service published a descriptor that failed authenticated identity verification");
				if (!processIsAlive(descriptor.pid)) throw new Error("Flow service exited before authenticated startup completed");
			}
			await pause(input.signal, STARTUP_POLL_MS);
		}
		throw new Error(`Timed out after ${STARTUP_TIMEOUT_MS} ms waiting for the Flow service descriptor`);
	} catch (error) {
		// Do not kill an already-published shared service: cancellation simply leaves it to its idle
		// lifecycle. A pre-descriptor child that is still stuck is our own failed startup, so retire
		// that exact child rather than leaking an unobservable process.
		const published = await readDescriptor(descriptorPath).catch(() => undefined);
		if (!published && childState.child.pid && childState.exitCode === undefined && !childState.error) {
			try { childState.child.kill(); } catch { /* child may have exited between the state check and signal */ }
			await waitForChildExit(childState, 2_000);
		}
		throw error;
	}
}

async function readDescriptor(file: string): Promise<SharedServiceDescriptor | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("Flow service descriptor is malformed; refusing to launch another daemon");
	}
	return validateDescriptor(value);
}

function validateDescriptor(value: unknown): SharedServiceDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Flow service descriptor is invalid; refusing to launch another daemon");
	const descriptor = value as Record<string, unknown>;
	if (descriptor.protocol !== SHARED_SERVICE_PROTOCOL) throw new Error("Flow service descriptor uses an unsupported protocol");
	if (typeof descriptor.serviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(descriptor.serviceId)) throw new Error("Flow service descriptor has an invalid service identity");
	if (!Number.isSafeInteger(descriptor.pid) || (descriptor.pid as number) < 1) throw new Error("Flow service descriptor has an invalid process id");
	if (typeof descriptor.controlToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.controlToken)) throw new Error("Flow service descriptor has an invalid private control token");
	if (typeof descriptor.startedAt !== "number" || !Number.isSafeInteger(descriptor.startedAt) || descriptor.startedAt < 0) throw new Error("Flow service descriptor has an invalid start time");
	if (typeof descriptor.url !== "string") throw new Error("Flow service descriptor has an invalid browser URL");
	const browserUrl = parseLoopbackUrl(descriptor.url);
	if (!/^[0-9A-Za-z]{4}$/.test(browserUrl.searchParams.get("token") ?? "")) throw new Error("Flow service descriptor has an invalid dashboard token");
	return {
		protocol: SHARED_SERVICE_PROTOCOL,
		serviceId: descriptor.serviceId,
		pid: descriptor.pid as number,
		url: browserUrl.href,
		controlToken: descriptor.controlToken,
		startedAt: descriptor.startedAt,
	};
}

function parseLoopbackUrl(value: string): URL {
	let url: URL;
	try { url = new URL(value); }
	catch { throw new Error("Flow service descriptor URL is invalid"); }
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || !url.port || url.pathname !== "/") {
		throw new Error("Flow service descriptor URL is not a loopback dashboard URL");
	}
	return url;
}

async function verifyDescriptor(descriptor: SharedServiceDescriptor, signal?: AbortSignal): Promise<"ready" | "unreachable" | "invalid"> {
	let response: PrivateResponse;
	try {
		response = await privateRequest(descriptor, "/internal/status", undefined, undefined, MAX_CONTROL_BODY_BYTES, signal);
	} catch (error) {
		if (isAbort(error) || signal?.aborted) throw abortError(signal);
		return "unreachable";
	}
	if (response.status === 401 || response.status === 403 || response.status === 404) return "invalid";
	if (response.status !== 200) return "unreachable";
	if (!response.value || typeof response.value !== "object" || Array.isArray(response.value)) return "invalid";
	const value = response.value as Record<string, unknown>;
	return value.protocol === descriptor.protocol && value.serviceId === descriptor.serviceId ? "ready" : "invalid";
}

async function readOwnerFile(file: string): Promise<LockOwner | undefined> {
	let raw: string;
	try { raw = await fs.readFile(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let value: unknown;
	try { value = JSON.parse(raw); }
	catch { throw new Error("Flow startup lock is malformed; refusing an uncoordinated launch"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Flow startup lock has an unknown owner; refusing an uncoordinated launch");
	const record = value as Record<string, unknown>;
	if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || typeof record.nonce !== "string" || !/^[a-f0-9]{32}$/i.test(record.nonce)) {
		throw new Error("Flow startup lock has an unknown owner; refusing an uncoordinated launch");
	}
	return { pid: record.pid as number, nonce: record.nonce };
}

async function reclaimDeadOwner(lockPath: string, observed: LockOwner, signal?: AbortSignal): Promise<void> {
	const reclaimPath = `${lockPath}${RECLAIM_LOCK_SUFFIX}`;
	const reclaimer = { pid: process.pid, nonce: randomBytes(16).toString("hex") } satisfies LockOwner;
	if (!await createExclusiveOwnerFile(reclaimPath, reclaimer)) {
		const other = await readOwnerFile(reclaimPath);
		if (!other) return;
		if (!processIsAlive(other.pid)) {
			throw new Error(`Flow startup reclaim lock ${reclaimPath} is owned by dead PID ${other.pid}; refusing unsafe automatic recovery. After confirming no Flow daemon or live Pi uses this profile, remove only this stale reclaim lock and retry.`);
		}
		await pause(signal, STARTUP_POLL_MS);
		return;
	}
	try {
		const current = await readOwnerFile(lockPath);
		if (!current || current.pid !== observed.pid || current.nonce !== observed.nonce) return;
		if (processIsAlive(current.pid)) return;
		await fs.unlink(lockPath);
	} finally {
		await releaseOwnerFile(reclaimPath, reclaimer);
	}
}

async function createExclusiveOwnerFile(file: string, owner: LockOwner): Promise<boolean> {
	const temporary = `${file}.${process.pid}.${owner.nonce}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
		try {
			await fs.link(temporary, file);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	} finally {
		await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

async function releaseOwnerFile(file: string, owner: LockOwner): Promise<void> {
	const current = await readOwnerFile(file).catch(() => undefined);
	if (!current || current.pid !== owner.pid || current.nonce !== owner.nonce) return;
	await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

async function removeDescriptorIfSame(file: string, expected: SharedServiceDescriptor): Promise<void> {
	const current = await readDescriptor(file);
	if (!current || current.serviceId !== expected.serviceId || current.pid !== expected.pid) return;
	if (processIsAlive(current.pid)) return;
	await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

function spawnDaemon(agentDir: string, port: number, idleMs?: number): ChildState {
	const nodeExecutable = isNodeExecutable(process.execPath) ? process.execPath : "node";
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	// An explicit desired idle policy configures only a daemon started by this call. Normal sessions
	// inherit no arbitrary PI, auth, NODE_OPTIONS or model credentials.
	if (idleMs !== undefined) env.PI_PERSONA_FLOW_IDLE_MS = String(idleMs);
	else {
		const idleOverride = process.env.PI_PERSONA_FLOW_IDLE_MS;
		if (idleOverride !== undefined) env.PI_PERSONA_FLOW_IDLE_MS = idleOverride;
	}
	const child = spawn(nodeExecutable, ["--experimental-strip-types", ENTRY_PATH, agentDir, String(port)], {
		cwd: agentDir,
		detached: true,
		windowsHide: true,
		stdio: "ignore",
		env,
	});
	let resolveExited!: () => void;
	const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
	const state: ChildState = { child, exited };
	child.once("error", (error) => { state.error = error; });
	child.once("exit", (code, signal) => {
		state.exitCode = code;
		state.exitSignal = signal;
		resolveExited();
	});
	child.unref();
	return state;
}

function isNodeExecutable(executable: string): boolean {
	const name = path.basename(executable).toLowerCase();
	return name === "node" || name === "node.exe";
}

async function registerClient(descriptor: SharedServiceDescriptor, registration: WorkspaceRegistration, signal?: AbortSignal): Promise<{ workspaceId: string }> {
	const response = await privateRequest(descriptor, "/internal/register", registration, undefined, MAX_CONTROL_BODY_BYTES, signal);
	if (response.status !== 200) throw privateStatusError("registration", response.status);
	if (!response.value || typeof response.value !== "object" || Array.isArray(response.value) || typeof (response.value as Record<string, unknown>).workspaceId !== "string") {
		throw new Error("Flow service returned an invalid registration response");
	}
	return { workspaceId: (response.value as Record<string, unknown>).workspaceId as string };
}

async function unregisterClient(descriptor: SharedServiceDescriptor, clientId: string): Promise<void> {
	const response = await privateRequest(descriptor, "/internal/unregister", { clientId });
	if (response.status !== 200 && response.status !== 204 && response.status !== 404) throw privateStatusError("unregister", response.status);
}

async function privateRequest(
	descriptor: SharedServiceDescriptor,
	pathname: string,
	value?: unknown,
	serializedBody?: string,
	maxBodyBytes = MAX_CONTROL_BODY_BYTES,
	signal?: AbortSignal,
): Promise<PrivateResponse> {
	throwIfAborted(signal);
	const browserUrl = parseLoopbackUrl(descriptor.url);
	const url = new URL(pathname, browserUrl.origin);
	const body = serializedBody ?? (value === undefined ? undefined : JSON.stringify(value));
	if (body !== undefined && Buffer.byteLength(body) > maxBodyBytes) throw new RangeError("Flow control request exceeds its bounded body size");
	const requestSignal = boundedSignal(signal, CONTROL_REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			method: body === undefined ? "GET" : "POST",
			redirect: "error",
			headers: {
				[CONTROL_TOKEN_HEADER]: descriptor.controlToken,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body }),
			signal: requestSignal.signal,
		});
	} catch (error) {
		requestSignal.dispose();
		if (signal?.aborted) throw abortError(signal);
		if (requestSignal.timedOut()) throw new Error(`Flow service request ${pathname} timed out`);
		throw new Error(`Flow service request ${pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const responseBody = await readBoundedBody(response, MAX_CONTROL_BODY_BYTES);
		let parsed: unknown;
		if (responseBody) {
			try { parsed = JSON.parse(responseBody); }
			catch { parsed = undefined; }
		}
		return { status: response.status, value: parsed };
	} finally {
		requestSignal.dispose();
	}
}

async function waitForChildExit(state: ChildState, timeoutMs: number): Promise<void> {
	if (state.exitCode !== undefined || state.error) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			state.exited,
			new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error("Flow service response exceeded its bounded size");
			}
			chunks.push(Buffer.from(chunk.value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, size).toString("utf8");
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		dispose: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function privateStatusError(operation: string, status: number): Error {
	return new Error(`Flow service ${operation} failed (HTTP ${status})`);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("The Flow attachment was cancelled", "AbortError");
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

async function pause(signal: AbortSignal | undefined, ms: number): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			signal?.removeEventListener("abort", abort);
			resolve();
		}
		function abort(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(abortError(signal));
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}
