import { closeSync, fstatSync, lstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

export const FLOW_SETTINGS_CHANNEL = "pi-persona:settings:collect:v1";

export const DEFAULT_FLOW_SETTINGS: Readonly<FlowPreferences> = Object.freeze({
	flowEnabled: true,
	flowPort: 7_874,
	flowIdleMs: 60_000,
});

export interface FlowPreferences {
	flowEnabled: boolean;
	flowPort: number;
	flowIdleMs: number;
}

export interface FlowSettingsEnvironment {
	PI_PERSONA_FLOW_PORT?: string;
	PI_PERSONA_FLOW_IDLE_MS?: string;
}

const MAX_SETTINGS_BYTES = 1_048_576;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function validPort(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 65_535;
}

function validIdleMs(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 50 && value <= 60_000;
}

function envPort(value: string): number | undefined {
	if (!/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return validPort(parsed) ? parsed : undefined;
}

function envIdleMs(value: string): number | undefined {
	if (!/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return validIdleMs(parsed) ? parsed : undefined;
}

function warn(warnings: string[] | undefined, key: string): void {
	if (warnings && !warnings.includes(key)) warnings.push(key);
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.isFile() && right.isFile();
}

function sameSnapshot(left: Stats, right: Stats): boolean {
	return sameIdentity(left, right)
		&& left.size === right.size
		&& left.nlink === right.nlink
		&& left.mtimeMs === right.mtimeMs
		&& left.ctimeMs === right.ctimeMs;
}

function hasInvalidParent(agentDir: string, warnings?: string[]): void {
	try {
		if (!statSync(agentDir).isDirectory()) {
			warn(warnings, "The canonical settings path has an invalid parent; Flow defaults were used.");
			return;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warn(warnings, "The canonical settings path has an invalid parent; Flow defaults were used.");
		}
		return;
	}
	try {
		if (!statSync(join(agentDir, "persona")).isDirectory()) {
			warn(warnings, "The canonical settings path has an invalid parent; Flow defaults were used.");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warn(warnings, "The canonical settings path has an invalid parent; Flow defaults were used.");
		}
	}
}

function readCanonicalFile(file: string, agentDir: string, warnings?: string[]): string | undefined {
	let descriptor: number | undefined;
	try {
		const pathBefore = lstatSync(file);
		if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.nlink !== 1) {
			warn(warnings, "The canonical settings file is not a safe regular file; Flow defaults were used.");
			return undefined;
		}
		if (pathBefore.size > MAX_SETTINGS_BYTES) {
			warn(warnings, "The canonical settings file exceeds Flow's read limit; Flow defaults were used.");
			return undefined;
		}

		descriptor = openSync(file, "r");
		const before = fstatSync(descriptor);
		if (!sameIdentity(pathBefore, before) || !sameSnapshot(pathBefore, before) || before.nlink !== 1) {
			warn(warnings, "The canonical settings file changed while opening; Flow defaults were used.");
			return undefined;
		}
		if (before.size > MAX_SETTINGS_BYTES) {
			warn(warnings, "The canonical settings file exceeds Flow's read limit; Flow defaults were used.");
			return undefined;
		}

		// Read at most one byte beyond the limit, even if another process grows the file after stat.
		const bytes = Buffer.allocUnsafe(MAX_SETTINGS_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(descriptor, bytes, length, bytes.length - length, length);
			if (count === 0) break;
			length += count;
		}
		const after = fstatSync(descriptor);
		const pathAfter = lstatSync(file);
		if (length > MAX_SETTINGS_BYTES || after.size > MAX_SETTINGS_BYTES) {
			warn(warnings, "The canonical settings file exceeds Flow's read limit; Flow defaults were used.");
			return undefined;
		}
		if (!sameSnapshot(before, after) || length !== before.size || !sameSnapshot(after, pathAfter) || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1) {
			warn(warnings, "The canonical settings file changed while reading; Flow defaults were used.");
			return undefined;
		}
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
			return text.startsWith("\uFEFF") ? text.slice(1) : text;
		} catch {
			warn(warnings, "The canonical settings file is malformed UTF-8; Flow defaults were used.");
			return undefined;
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			hasInvalidParent(agentDir, warnings);
		} else {
			warn(warnings, "The canonical settings file could not be read; Flow defaults were used.");
		}
		return undefined;
	} finally {
		if (descriptor !== undefined) {
			try { closeSync(descriptor); }
			catch { warn(warnings, "The canonical settings file could not be closed cleanly."); }
		}
	}
}

/** Resolve only Flow's public settings. Invalid stored/env values fall back to bounded defaults. */
export function resolveFlowSettings(
	preferences: unknown,
	env: FlowSettingsEnvironment,
	warnings?: string[],
): FlowPreferences {
	const values = isPlainObject(preferences) ? preferences : {};
	if (preferences !== undefined && !isPlainObject(preferences)) warn(warnings, "The Flow preferences section is invalid; defaults were used.");
	if (Object.hasOwn(values, "flowEnabled") && typeof values.flowEnabled !== "boolean") {
		warn(warnings, "The saved flowEnabled preference is invalid; its default was used.");
	}
	const flowEnabled = typeof values.flowEnabled === "boolean"
		? values.flowEnabled
		: DEFAULT_FLOW_SETTINGS.flowEnabled;
	if (Object.hasOwn(values, "flowPort") && !validPort(values.flowPort)) {
		warn(warnings, "The saved flowPort preference is invalid; its default was used.");
	}
	const savedPort = validPort(values.flowPort) ? values.flowPort : DEFAULT_FLOW_SETTINGS.flowPort;
	if (Object.hasOwn(values, "flowIdleMs") && !validIdleMs(values.flowIdleMs)) {
		warn(warnings, "The saved flowIdleMs preference is invalid; its default was used.");
	}
	const savedIdleMs = validIdleMs(values.flowIdleMs) ? values.flowIdleMs : DEFAULT_FLOW_SETTINGS.flowIdleMs;
	const parsedEnvPort = env.PI_PERSONA_FLOW_PORT === undefined ? undefined : envPort(env.PI_PERSONA_FLOW_PORT);
	if (env.PI_PERSONA_FLOW_PORT !== undefined && parsedEnvPort === undefined) {
		warn(warnings, "PI_PERSONA_FLOW_PORT is invalid; the default port was used.");
	}
	const parsedEnvIdleMs = env.PI_PERSONA_FLOW_IDLE_MS === undefined ? undefined : envIdleMs(env.PI_PERSONA_FLOW_IDLE_MS);
	if (env.PI_PERSONA_FLOW_IDLE_MS !== undefined && parsedEnvIdleMs === undefined) {
		warn(warnings, "PI_PERSONA_FLOW_IDLE_MS is invalid; the default idle window was used.");
	}
	return {
		flowEnabled,
		// Preserve the Flow extension's existing port grammar: decimal digits only and out of-range
		// values fall back to 7874. In particular, do not trim whitespace here.
		flowPort: env.PI_PERSONA_FLOW_PORT === undefined ? savedPort : parsedEnvPort ?? DEFAULT_FLOW_SETTINGS.flowPort,
		// The detached service has always required an integer between 50 and 60000 milliseconds.
		flowIdleMs: env.PI_PERSONA_FLOW_IDLE_MS === undefined ? savedIdleMs : parsedEnvIdleMs ?? DEFAULT_FLOW_SETTINGS.flowIdleMs,
	};
}

/** Read the canonical pi-persona settings file without importing its runtime or writing anything. */
export function readFlowSettings(agentDir: string, env: FlowSettingsEnvironment, warnings?: string[]): FlowPreferences {
	let preferences: unknown;
	const text = readCanonicalFile(join(agentDir, "persona", "settings.json"), agentDir, warnings);
	if (text !== undefined) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (isPlainObject(parsed) && parsed.version === 1) {
				if (isPlainObject(parsed.preferences)) preferences = parsed.preferences;
				else warn(warnings, "The canonical settings file has no valid preferences object; Flow defaults were used.");
			} else {
				warn(warnings, "The canonical settings file is malformed or has an unsupported version; Flow defaults were used.");
			}
		} catch {
			warn(warnings, "The canonical settings file is malformed or has an unsupported version; Flow defaults were used.");
		}
	}
	return resolveFlowSettings(preferences, env, warnings);
}
