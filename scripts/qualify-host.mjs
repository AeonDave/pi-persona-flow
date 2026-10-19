#!/usr/bin/env node
/**
 * Qualify pi-persona-flow through an explicitly installed Pi 1.3 SDK. This is a
 * headless, offline host check: the only profile/workspace is a fresh OS-temp
 * root, the model provider is Pi's local faux provider, and outbound fetches are
 * blocked. An optional pi-persona source entry exercises the real producer and
 * its worker/session identities against Flow's file-backed multi-stream reader.
 *
 * Usage:
 *   node --import tsx scripts/qualify-host.mjs "C:\\...\\node_modules\\@earendil-works\\pi-coding-agent" ["D:\\...\\pi-persona\\src\\extension.ts"]
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SERVICE_DESCRIPTOR_FILE, SERVICE_DIRECTORY } from "../shared/workspaces.ts";
import { waitForServiceIdle } from "../test/setup/service-cleanup.ts";

const PACKAGE_NAMES = ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui", "pi-codemode", "pi-mcp"];
const hostArg = process.argv[2];
if (!hostArg || !isAbsolute(hostArg)) {
	throw new Error("Pass the absolute installed @earendil-works/pi-coding-agent package root as argument 1.");
}

const hostRoot = resolve(hostArg);
const hostPackage = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
assert.equal(hostPackage.name, "@earendil-works/pi-coding-agent", `Unexpected Pi host package at ${hostRoot}`);
assert.equal(hostPackage.version, "1.3.0", `Expected installed Pi 1.3.0, found ${hostPackage.version}`);

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const flowEntry = join(projectRoot, "src", "extension.ts");
const personaArg = process.argv[3];
const personaEntry = personaArg ? resolve(personaArg) : undefined;
if (personaArg && !isAbsolute(personaArg)) throw new Error("Optional pi-persona extension path must be absolute.");
if (personaEntry && !existsSync(personaEntry)) throw new Error(`pi-persona extension path does not exist: ${personaEntry}`);

// Clear every Pi/provider setting before importing host or extension code. Pi receives a
// throwaway profile and an in-memory credential store; no operator auth or telemetry is read.
const savedEnv = { ...process.env };
const envWhitelist = new Set(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC"]);
for (const key of Object.keys(process.env)) if (!envWhitelist.has(key)) delete process.env[key];
process.env.PI_OFFLINE = "1";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-persona-flow-host-qualification-"));
const workspace = join(tempRoot, "workspace");
const agentDir = join(tempRoot, "agent");
const probeEntry = join(tempRoot, "pi13-host-identity-probe.ts");
const flowPort = "0";
let fetchBefore;
let networkRequests = 0;
const sessions = [];
let teardownError;

function restoreEnvironment() {
	for (const key of Object.keys(process.env)) delete process.env[key];
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

function assertOwnTempRoot() {
	const target = resolve(tempRoot);
	assert.equal(dirname(target), resolve(tmpdir()), `Refusing to remove non-temp path: ${target}`);
	assert.ok(target.split(/[\\/]/).at(-1)?.startsWith("pi-persona-flow-host-qualification-"), "Unexpected temporary root name");
}

function serviceDescriptorPath() {
	return join(agentDir, SERVICE_DIRECTORY, SERVICE_DESCRIPTOR_FILE);
}

async function readServiceDescriptor() {
	return JSON.parse(await readFile(serviceDescriptorPath(), "utf8"));
}

function processIsAlive(pid) {
	try { process.kill(pid, 0); return true; }
	catch (error) { return error?.code !== "ESRCH"; }
}

function captureWrites(stream) {
	let value = "";
	const original = stream.write;
	stream.write = function (chunk, encoding, callback) {
		value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : undefined);
		const done = typeof encoding === "function" ? encoding : callback;
		if (typeof done === "function") queueMicrotask(done);
		return true;
	};
	return {
		read: () => value,
		restore: () => { stream.write = original; },
	};
}

async function captureOutput(callback) {
	const stdout = captureWrites(process.stdout);
	const stderr = captureWrites(process.stderr);
	try {
		await callback();
		return { stdout: stdout.read(), stderr: stderr.read() };
	} finally {
		stdout.restore();
		stderr.restore();
	}
}

function writeError(error) {
	process.stderr.write(`${JSON.stringify({ status: "FAIL", host: hostPackage.name, version: hostPackage.version, error: error instanceof Error ? error.message : String(error) })}\n`);
	if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
}

function makePrivateCredentials() {
	const values = new Map();
	return {
		async read(providerId) { return values.get(providerId); },
		async list() { return [...values].map(([providerId, value]) => ({ providerId, type: value.type })); },
		async modify(providerId, update) {
			const next = await update(values.get(providerId));
			if (next !== undefined) values.set(providerId, next);
			return next;
		},
		async delete(providerId) { values.delete(providerId); },
	};
}

async function makeLoader(host, extensions, settingsManager) {
	const loader = new host.DefaultResourceLoader({
		cwd: workspace,
		agentDir,
		settingsManager,
		additionalExtensionPaths: extensions,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();
	const state = loader.getExtensions();
	assert.deepEqual(state.errors, [], "Installed Pi 1.3's real extension loader must load all requested extensions cleanly");
	assert.equal(state.extensions.length, extensions.length, "Pi's real extension loader omitted or duplicated an extension");
	return loader;
}

async function makeSession(host, { extensions, modelRuntime, model, label, noFlow = false }) {
	const settingsManager = host.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = await makeLoader(host, extensions, settingsManager);
	const sessionManager = host.SessionManager.inMemory(workspace);
	const { session } = await host.createAgentSession({
		cwd: workspace,
		agentDir,
		resourceLoader,
		settingsManager,
		modelRuntime,
		model,
		sessionManager,
	});
	const record = { label, session, sessionManager, resourceLoader };
	sessions.push(record);
	if (noFlow) session.extensionRunner?.setFlagValue("no-flow", true);
	return record;
}

async function bindHeadless(record) {
	return captureOutput(async () => {
		await record.session.bindExtensions({ mode: "json" });
	});
}

async function snapshotFrom(url) {
	const endpoint = new URL(url);
	endpoint.pathname = "/api/snapshot";
	const response = await fetch(endpoint);
	assert.equal(response.status, 200, `Authenticated snapshot returned HTTP ${response.status}`);
	return await response.json();
}

async function waitForSnapshot(url, predicate, description, timeoutMs = 12_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	do {
		last = await snapshotFrom(url);
		if (predicate(last)) return last;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	} while (Date.now() < deadline);
	assert.fail(`Timed out waiting for ${description}; last snapshot: ${JSON.stringify(last)}`);
}

const hostRequire = createRequire(pathToFileURL(join(hostRoot, "package.json")));
const typeboxEntry = hostRequire.resolve("typebox");
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "typebox") {
			return nextResolve(pathToFileURL(typeboxEntry).href, context);
		}
		for (const packageName of PACKAGE_NAMES) {
			const bare = `@earendil-works/${packageName}`;
			if (specifier !== bare) continue;
			const packageRoot = packageName === "pi-coding-agent"
				? hostRoot
				: join(hostRoot, "node_modules", "@earendil-works", packageName);
			return nextResolve(pathToFileURL(join(packageRoot, "dist", "index.js")).href, context);
		}
		return nextResolve(specifier, context);
	},
});

try {
	await mkdir(workspace, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_PERSONA_FLOW_PORT = flowPort;
	// The detached service inherits this test-only interval. It is still required to honor its
	// normal cleanup/descriptor protocol before the isolated profile may be removed.
	process.env.PI_PERSONA_FLOW_IDLE_MS = "100";
	// Import the source helper only after profile isolation and installed-host package routing.
	const { workspaceHash } = await import("../src/tailer.ts");

	for (const packageName of PACKAGE_NAMES.slice(1)) {
		const packageRoot = join(hostRoot, "node_modules", "@earendil-works", packageName);
		const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		assert.equal(packageJson.version, "1.3.0", `Pi host dependency ${packageName} is not aligned to 1.3.0`);
	}

	const flowHtml = join(projectRoot, "dist", "web", "index.html");
	assert.ok(existsSync(flowHtml), "Build the shipped dashboard before host qualification (dist/web/index.html is missing)");
	await writeFile(probeEntry, `import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";\nexport default function (pi) {\n  pi.on("session_start", (_event, ctx) => {\n    pi.appendEntry("flow-host-identity-probe", { version: VERSION, agentDir: getAgentDir(), mode: ctx.mode, hasUI: ctx.hasUI });\n  });\n}\n`, "utf8");

	const host = await import(pathToFileURL(join(hostRoot, "dist", "index.js")).href);
	assert.equal(host.VERSION, "1.3.0");
	const fauxModule = await import(pathToFileURL(join(hostRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "faux.js")).href);
	const settingsManager = host.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const runtime = await host.ModelRuntime.create({
		credentials: makePrivateCredentials(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const providerId = "pi-persona-flow-qualification";
	const modelId = "local";
	const faux = fauxModule.fauxProvider({ provider: providerId, models: [{ id: modelId, name: "Pi 1.3 local qualification" }] });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey(providerId, "synthetic-qualification-key-never-transmitted");
	const model = runtime.getModel(providerId, modelId);
	assert.ok(model, "The local faux model failed to register in Pi's real ModelRuntime");

	fetchBefore = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
		if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
			return fetchBefore(input, init);
		}
		networkRequests += 1;
		throw new Error("Pi 1.3 qualification network tripwire: outbound HTTP is disabled.");
	};

	// The host identity probe is itself loaded by Pi's extension loader. This catches cases where
	// Node's own resolver hook is correct but the host loader's package alias points elsewhere.
	const optedOut = await makeSession(host, { extensions: [flowEntry, probeEntry], modelRuntime: runtime, model, label: "no-flow", noFlow: true });
	const optedOutOutput = await bindHeadless(optedOut);
	const optedOutUrl = optedOutOutput.stderr.match(/flow dashboard at (https?:\/\/\S+)/)?.[1];
	assert.equal(optedOutUrl, undefined, "--no-flow must not start the dashboard in a real headless Pi session");
	assert.equal(optedOutOutput.stdout.includes("flow dashboard at "), false, "--no-flow must not write an autostart URL to stdout");
	const disabledCommand = optedOut.session.extensionRunner?.getCommand("dashboard");
	assert.ok(disabledCommand, "The /dashboard command remains discoverable when the run-level opt-out is set");
	const disabledOutput = await captureOutput(async () => {
		await disabledCommand.handler("status", optedOut.session.extensionRunner.createCommandContext());
	});
	assert.match(disabledOutput.stdout + disabledOutput.stderr, /--no-flow/, "Manual dashboard start/status must explain that --no-flow disables the whole run");
	const identityEntry = optedOut.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "flow-host-identity-probe");
	assert.ok(identityEntry, "Pi's installed loader did not execute the host identity probe");
	assert.equal(identityEntry.data?.version, "1.3.0", "The extension loader did not resolve imports to installed Pi 1.3");
	assert.equal(resolve(identityEntry.data?.agentDir), resolve(agentDir), "The extension loader did not use the isolated Pi profile");
	assert.equal(identityEntry.data?.mode, "json", "The qualification session is not actually headless/json mode");
	assert.equal(identityEntry.data?.hasUI, false, "Pi unexpectedly exposed an interactive UI in headless mode");

	for (const marker of ["PI_PERSONA_LEG", "PI_PERSONA_CHILD"]) {
		process.env[marker] = "1";
		try {
			const workerContext = await makeSession(host, { extensions: [flowEntry, probeEntry], modelRuntime: runtime, model, label: marker });
			const output = await bindHeadless(workerContext);
			assert.equal(output.stderr.includes("flow dashboard at "), false, `${marker}=1 must suppress Flow autostart in a real Pi loader`);
			assert.equal(output.stdout.includes("flow dashboard at "), false, `${marker}=1 must not announce a dashboard on stdout`);
			assert.equal(workerContext.session.extensionRunner?.getCommand("dashboard"), undefined, `${marker}=1 must not register Flow commands in a worker loader`);
		} finally {
			delete process.env[marker];
		}
	}

	// Run the enabled path with no flag override. This proves the new default through the actual
	// installed SDK lifecycle, and that headless announcement stays off stdout/JSON output.
	const viewer = await makeSession(host, { extensions: [flowEntry, probeEntry], modelRuntime: runtime, model, label: "viewer" });
	const viewerOutput = await bindHeadless(viewer);
	const dashboardUrl = viewerOutput.stderr.match(/flow dashboard at (https?:\/\/\S+)/)?.[1];
	assert.ok(dashboardUrl, `Default headless Pi 1.3 startup did not announce its authenticated URL on stderr: ${viewerOutput.stderr}`);
	assert.equal(viewerOutput.stdout.includes("flow dashboard at "), false, "Default headless autostart polluted stdout");
	const parsedDashboardUrl = new URL(dashboardUrl);
	assert.equal(parsedDashboardUrl.hostname, "127.0.0.1", "Dashboard must bind only to loopback");
	assert.match(parsedDashboardUrl.searchParams.get("token") ?? "", /^[0-9A-Za-z]{4}$/, "Dashboard URL did not contain its four-character launch token");
	const initialService = await readServiceDescriptor();
	assert.notEqual(initialService.pid, process.pid, "Flow did not launch its detached shared-service process");
	assert.ok(processIsAlive(initialService.pid), "The detached shared-service PID is not running");
	assert.equal(initialService.url, dashboardUrl, "The announced browser URL differs from the private service descriptor");
	const viewerCommand = viewer.session.extensionRunner?.getCommand("dashboard");
	assert.ok(viewerCommand, "The actual host did not register /dashboard");

	const flowRootResponse = await fetch(dashboardUrl);
	assert.equal(flowRootResponse.status, 200, "The tokenized dashboard URL did not serve the shipped page");
	assert.match(flowRootResponse.headers.get("content-type") ?? "", /text\/html/i);
	const html = await flowRootResponse.text();
	assert.match(html, /<html/i, "Dashboard root was not HTML");
	assert.match(html, /<div[^>]+id=["']root["']/i, "Shipped dashboard page has no React root mount point");
	const apiUrl = new URL(dashboardUrl);
	apiUrl.pathname = "/api/snapshot";
	const unauthorizedUrl = new URL(apiUrl);
	unauthorizedUrl.search = "";
	assert.equal((await fetch(unauthorizedUrl)).status, 401, "Snapshot API accepted a request without its launch token");
	const healthUrl = new URL(dashboardUrl);
	healthUrl.pathname = "/health";
	assert.deepEqual(await (await fetch(healthUrl)).json(), { ok: true, clients: 0 }, "Dashboard health endpoint returned the wrong listener state");

	let producerSessionIds = [];
	let workerFound = false;
	if (personaEntry) {
		const producerContract = await import(pathToFileURL(join(dirname(personaEntry), "telemetry", "contract.ts")).href);
		const personaDir = join(agentDir, "persona", "agents");
		const projectAgentsDir = join(workspace, ".pi", "agents");
		await mkdir(personaDir, { recursive: true });
		await mkdir(projectAgentsDir, { recursive: true });
		await writeFile(join(personaDir, "flow-qualification.md"), "---\nname: flow-qualification\nlabel: Flow host qualification\npersona: true\n---\nOffline qualification supervisor. Delegate the requested observation to the named worker.\n", "utf8");
		await writeFile(join(projectAgentsDir, "flow-worker.md"), "---\nname: flow-worker\ndescription: Offline host qualification worker\n---\nReturn the concise result requested by the task.\n", "utf8");

		const producerOne = await makeSession(host, { extensions: [flowEntry, personaEntry], modelRuntime: runtime, model, label: "pi-persona-one" });
		const producerTwo = await makeSession(host, { extensions: [flowEntry, personaEntry], modelRuntime: runtime, model, label: "pi-persona-two" });
		const producerOneOutput = await bindHeadless(producerOne);
		const producerTwoOutput = await bindHeadless(producerTwo);
		for (const [label, output] of [["first", producerOneOutput], ["second", producerTwoOutput]]) {
			const attachedUrl = output.stderr.match(/flow dashboard at (https?:\/\/\S+)/)?.[1];
			assert.equal(attachedUrl, dashboardUrl, `The ${label} real producer did not attach to the same shared dashboard`);
			assert.equal(output.stdout.includes("flow dashboard at "), false, `The ${label} producer polluted headless stdout`);
		}
		const sharedService = await readServiceDescriptor();
		assert.equal(sharedService.serviceId, initialService.serviceId, "A second Pi session launched a parallel service instead of sharing the first");
		assert.equal(sharedService.pid, initialService.pid, "The same profile is served by multiple daemon processes");
		assert.equal(sharedService.url, dashboardUrl, "Independent Pi sessions did not resolve the same stable dashboard URL");
		const firstSessionId = producerOne.sessionManager.getSessionId();
		const secondSessionId = producerTwo.sessionManager.getSessionId();
		assert.ok(firstSessionId && secondSessionId, "Pi did not assign session identities to the real producer sessions");
		assert.notEqual(firstSessionId, secondSessionId, "Independent Pi sessions unexpectedly share a session identity");
		producerSessionIds = [firstSessionId, secondSessionId];

		// A deterministic local faux response exercises both actual producer sessions plus
		// pi-persona's real delegate tool, in-process engine and telemetry projection. No network or
		// model credentials are available here.
		faux.setResponses([fauxModule.fauxAssistantMessage("The second independent producer started locally.")]);
		await producerTwo.session.prompt("Start the second isolated offline producer session.");
		await producerOne.session.prompt("/persona flow-qualification");
		faux.setResponses([
			fauxModule.fauxAssistantMessage(fauxModule.fauxToolCall("delegate", {
				agent: "flow-worker",
				name: "Flow-identity-worker",
				task: "Return one short observation for the isolated host qualification.",
				sync: true,
			}, { id: "flow-host-qualification-delegate" }), { stopReason: "toolUse" }),
			fauxModule.fauxAssistantMessage("The flow-worker returned its local qualification observation."),
			fauxModule.fauxAssistantMessage("The actual Pi worker completed successfully."),
		]);
		await producerOne.session.prompt("Delegate the isolated observation to flow-worker.");
		await producerOne.session.agent.waitForIdle();
		assert.equal(faux.state.callCount, 4, `Expected the second producer plus supervisor, worker and supervisor faux turns; got ${faux.state.callCount}`);
		const delegateToolResult = producerOne.sessionManager.getBranch()
			.map((entry) => entry.type === "message" ? entry.message : undefined)
			.find((message) => message?.role === "toolResult" && message.toolName === "delegate");
		assert.equal(delegateToolResult?.isError, false, "The actual Pi delegate tool did not report success");
		assert.equal(delegateToolResult?.details?.views?.[0]?.ok, true, "The delegate result did not mark the faux-backed worker successful");
		assert.equal(networkRequests, 0, "An external network request escaped the offline host harness");
		const workspaceCatalogUrl = new URL(dashboardUrl);
		workspaceCatalogUrl.pathname = "/api/workspaces";
		const workspaceCatalogResponse = await fetch(workspaceCatalogUrl);
		assert.equal(workspaceCatalogResponse.status, 200, "The shared service could not list registered Pi sessions");
		const workspaceCatalog = await workspaceCatalogResponse.json();
		assert.equal(workspaceCatalog.workspaces.length, 1, "Sessions in the same cwd created duplicate workspace records");
		assert.equal(workspaceCatalog.workspaces[0]?.activeSessions, 3, "The viewer and both independent Pi sessions were not all registered in one workspace");
		assert.ok(!JSON.stringify(workspaceCatalog).includes(agentDir), "Workspace catalog exposed the isolated Pi profile path");

		const expectedWorkspaceId = workspaceHash(workspace);
		const expectedInstances = (snapshot) => Object.values(snapshot.state.instances).filter((instance) =>
			instance.producerId === "pi-persona" && producerSessionIds.includes(instance.sessionId));
		const snapshot = await waitForSnapshot(dashboardUrl, (value) =>
			expectedInstances(value).length === 2 && Object.values(value.state.agents).some((agent) =>
				agent.producerId === "pi-persona" && agent.sessionId === firstSessionId && agent.agent === "flow-worker"),
		"two actual pi-persona session streams and the delegated worker projection");
		const actualInstances = expectedInstances(snapshot);
		assert.equal(actualInstances.length, 2, "Flow did not preserve both current pi-persona session identities");
		assert.deepEqual(new Set(actualInstances.map((instance) => instance.sessionId)), new Set(producerSessionIds));
		assert.ok(actualInstances.every((instance) => instance.displayName.length > 0), "pi-persona instance identity has no display name");
		assert.ok(actualInstances.every((instance) => instance.status === "active" || instance.status === "idle"), "A live producer session was incorrectly marked terminal/stale");
		assert.ok(actualInstances.every((instance) => instance.producerId === "pi-persona"), "Flow rewrote the actual telemetry producer identity");
		const startedEvents = snapshot.state.events.filter((event) =>
			event.type === "instance.started" && producerSessionIds.includes(event.sessionId));
		assert.equal(startedEvents.length, 2, "Flow did not retain both actual producer start envelopes");
		assert.ok(startedEvents.every((event) => event.version === producerContract.TELEMETRY_VERSION), "Flow changed the producer wire version");
		assert.ok(startedEvents.every((event) => event.producerId === producerContract.TELEMETRY_PRODUCER_ID), "Flow changed the producer id");
		assert.ok(startedEvents.every((event) => event.producerVersion === producerContract.TELEMETRY_PRODUCER_VERSION), "Flow did not ingest the current pi-persona producer version");
		assert.ok(startedEvents.every((event) => event.workspaceId === expectedWorkspaceId), "Flow did not preserve the producer workspace identity");
		assert.ok(startedEvents.every((event) => Number.isSafeInteger(event.seq) && event.seq > 0), "Flow accepted an invalid producer sequence");
		const worker = Object.values(snapshot.state.agents).find((agent) =>
			agent.producerId === "pi-persona" && agent.sessionId === firstSessionId && agent.agent === "flow-worker");
		assert.ok(worker, "Flow failed to map the real delegated worker to its producer session");
		assert.equal(worker.label, "Flow-identity-worker", "Flow lost the leader-assigned worker display identity");
		assert.ok(worker.key.includes(firstSessionId), "Flow's worker key is not scoped to its producer session");
		assert.ok(worker.parentId, "Flow lost the worker's supervisor parent identity");
		assert.equal(worker.status, "done", `Flow did not receive the producer's terminal success status (got ${worker.status})`);
		assert.equal(snapshot.state.instances[`pi-persona::${firstSessionId}`]?.producerId, "pi-persona", "The primary stream key does not preserve the producer/session tuple");
		assert.equal(snapshot.state.instances[`pi-persona::${firstSessionId}`]?.sessionId, firstSessionId, "The primary instance carries the wrong session id");
		const streamKeys = Object.keys(snapshot.state.lastSeq).filter((key) => key.startsWith("pi-persona::"));
		assert.ok(streamKeys.includes(`pi-persona::${firstSessionId}`) && streamKeys.includes(`pi-persona::${secondSessionId}`), "The reducer did not keep independent sequence cursors per producer/session stream");
		assert.ok(streamKeys.every((key) => snapshot.state.lastSeq[key] > 0), "A telemetry stream has no accepted event sequence");
		assert.ok(!JSON.stringify(snapshot.state.events.filter((event) => producerSessionIds.includes(event.sessionId))).includes("Return one short observation"), "Telemetry leaked the worker's task text into the dashboard snapshot");
		workerFound = true;
	}

	const authorizedSnapshot = await snapshotFrom(apiUrl);
	const piPersonaStreams = Object.keys(authorizedSnapshot.state.lastSeq).filter((key) => key.startsWith("pi-persona::"));
	assert.equal(piPersonaStreams.length >= 2, Boolean(personaEntry), "Snapshot stream cursors do not match the actual producer sessions");
	assert.ok(processIsAlive(initialService.pid), "Ending or detaching a Pi session killed the other sessions' shared dashboard");
	assert.equal(networkRequests, 0, "An external network request escaped the offline host harness");

	const summary = {
		status: "PASS",
		host: hostPackage.name,
		version: hostPackage.version,
		checks: {
			installedPi13ExtensionLoader: true,
			headlessDefaultAutostart: true,
			headlessStdoutClean: true,
			tokenizedDashboardPageAndApi: true,
			noFlowRunOptOut: true,
			...(personaEntry ? {
				actualPiPersonaProducer: true,
				producerSessionStreams: producerSessionIds.length,
				delegatedWorkerIdentity: workerFound,
				workspaceId: workspaceHash(workspace),
			} : {}),
		},
		requests: { fauxModel: faux.state.callCount, network: networkRequests },
	};
	process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
	writeError(error);
	process.exitCode = 1;
} finally {
	for (const record of [...sessions].reverse()) {
		try {
			await record.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		} catch (error) { teardownError ??= error; }
		try { await record.session.abort(); await record.session.agent.waitForIdle(); }
		catch (error) { teardownError ??= error; }
		try { record.session.dispose(); }
		catch (error) { teardownError ??= error; }
	}
	if (fetchBefore) globalThis.fetch = fetchBefore;
	let serviceIdle = true;
	try {
		await waitForServiceIdle(agentDir);
	} catch (error) {
		teardownError ??= error;
		serviceIdle = false;
	}
	try {
		assertOwnTempRoot();
		if (serviceIdle) await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		else process.stderr.write(`Qualification temp root retained while shared Flow service remains alive: ${tempRoot}\n`);
	} catch (error) { teardownError ??= error; }
	restoreEnvironment();
	if (teardownError) {
		process.stderr.write(`Qualification teardown failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}\n`);
		process.exitCode = 1;
	}
}
