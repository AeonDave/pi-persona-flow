import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SharedServiceDescriptor } from "../../shared/workspaces.ts";
import { startSharedService, type SharedService } from "./host.ts";
import { readBrowserBinding, writeBrowserBinding } from "./browser-binding.ts";

const DEFAULT_IDLE_MS = 60_000;
const MIN_IDLE_MS = 50;
const MAX_IDLE_MS = 60_000;

async function main(): Promise<void> {
	const agentDirArg = process.argv[2];
	const portArg = process.argv[3];
	if (!agentDirArg || !path.isAbsolute(agentDirArg)) throw new Error("Flow service requires an absolute agent directory argument");
	const port = parsePort(portArg);
	const agentDir = path.resolve(agentDirArg);
	const directory = path.join(agentDir, "persona-flow", "service-v1");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });

	let service: SharedService | undefined;
	let descriptor: SharedServiceDescriptor | undefined;
	let descriptorPath: string | undefined;
	let requestedClose: Promise<void> | undefined;
	let closeError: unknown;
	const closeOnSignal = () => {
		if (!service || requestedClose) return;
		requestedClose = service.close().catch((error: unknown) => { closeError = error; });
	};
	try {
		const binding = await readBrowserBinding(directory, port);
		service = await startSharedService({ agentDir, port: binding?.port ?? port, browserToken: binding?.token, idleMs: idleWindowMs() });
		await writeBrowserBinding(directory, port, service.url);
		descriptor = {
			protocol: service.protocol,
			serviceId: service.serviceId,
			pid: process.pid,
			url: service.url,
			controlToken: service.controlToken,
			startedAt: service.startedAt,
		};
		descriptorPath = path.join(directory, "service.json");
		await persistDescriptor(descriptorPath, descriptor);

		process.once("SIGINT", closeOnSignal);
		process.once("SIGTERM", closeOnSignal);
		if (process.platform === "win32") process.once("SIGBREAK", closeOnSignal);
		await service.closed;
		await requestedClose;
		if (closeError) throw closeError;
	} catch (error) {
		if (service) {
			try { await service.close(); }
			catch { /* preserve the startup or shutdown error that triggered cleanup */ }
			try { await service.closed; }
			catch { /* close has already reported the useful failure */ }
		}
		throw error;
	} finally {
		if (descriptor && descriptorPath) await removeOwnDescriptor(descriptorPath, descriptor);
	}
}

function parsePort(value: string | undefined): number {
	if (typeof value !== "string" || !/^\d{1,5}$/.test(value)) throw new Error("Flow service requires a desired port between 0 and 65535");
	const port = Number(value);
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("Flow service desired port is out of range");
	return port;
}

function idleWindowMs(): number {
	const value = process.env.PI_PERSONA_FLOW_IDLE_MS;
	if (value === undefined) return DEFAULT_IDLE_MS;
	if (!/^\d+$/.test(value)) throw new Error("PI_PERSONA_FLOW_IDLE_MS must be an integer from 50 to 60000");
	const milliseconds = Number(value);
	if (!Number.isSafeInteger(milliseconds) || milliseconds < MIN_IDLE_MS || milliseconds > MAX_IDLE_MS) {
		throw new Error("PI_PERSONA_FLOW_IDLE_MS must be an integer from 50 to 60000");
	}
	return milliseconds;
}

async function persistDescriptor(file: string, descriptor: SharedServiceDescriptor): Promise<void> {
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(descriptor), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		// Hard-linking makes publication atomic and non-overwriting. Startup ownership is enforced
		// by the Pi-side lock; EEXIST here detects a broken election instead of replacing a live token.
		await fs.link(temporary, file);
	} finally {
		await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

async function removeOwnDescriptor(file: string, expected: SharedServiceDescriptor): Promise<void> {
	let value: unknown;
	try { value = JSON.parse(await fs.readFile(file, "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		return;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const current = value as Record<string, unknown>;
	if (current.serviceId !== expected.serviceId || current.pid !== process.pid) return;
	await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

main().catch((error: unknown) => {
	// The detached parent intentionally ignores stdio; keep diagnostics local and token-free.
	process.stderr.write(`Flow service startup/shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
