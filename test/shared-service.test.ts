import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import * as http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CONTROL_TOKEN_HEADER } from "../shared/workspaces.ts";
import { TELEMETRY_VERSION, type TelemetryEvent } from "../shared/protocol.ts";
import { startSharedService } from "../src/service/host.ts";
import { workspaceHash } from "../src/tailer.ts";

function registration(agentDir: string, leaf: string, clientId: string, sessionId = clientId) {
  const cwd = join(agentDir, "projects", leaf);
  mkdirSync(cwd, { recursive: true });
  return {
    clientId,
    sessionId,
    pid: process.pid,
    workspaceId: workspaceHash(cwd),
    cwd,
    label: leaf,
  };
}

function event(workspaceId: string, sessionId: string, seq: number): TelemetryEvent {
  return {
    version: TELEMETRY_VERSION,
    producerId: "pi-persona",
    producerVersion: "1.20.0",
    id: `${sessionId}:${seq}`,
    seq,
    ts: Date.now(),
    sessionId,
    workspaceId,
    type: "instance.started",
    payload: { displayName: sessionId, persona: "", model: "", status: "active", pid: process.pid, contextPercent: 0, exocomEnabled: false },
  };
}

function endpoint(serviceUrl: string): string {
  return new URL(serviceUrl).origin;
}

function browserToken(serviceUrl: string): string {
  return new URL(serviceUrl).searchParams.get("token") ?? "";
}

async function control(
  service: Awaited<ReturnType<typeof startSharedService>>,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${endpoint(service.url)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      [CONTROL_TOKEN_HEADER]: service.controlToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true, message);
}

test("shared control plane is private and browser catalog exposes only safe workspace summaries", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-service-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, sweepMs: 60_000 });
  const workspace = registration(agentDir, "private-project", "client-1", "session-1");
  try {
    const missingSecret = await fetch(`${endpoint(service.url)}/internal/status`);
    assert.equal(missingSecret.status, 401);
    const originRejected = await control(service, "/internal/status", undefined, { Origin: "http://127.0.0.1" });
    assert.equal(originRejected.status, 403, "browser origins cannot use the private control plane");

    const status = await control(service, "/internal/status");
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { protocol: 1, serviceId: service.serviceId });

    const register = await control(service, "/internal/register", workspace);
    assert.equal(register.status, 200);
    assert.deepEqual(await register.json(), { workspaceId: workspace.workspaceId });
    assert.equal(service.clientCount(), 1);

    const catalogResponse = await fetch(`${endpoint(service.url)}/api/workspaces?token=${browserToken(service.url)}`);
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as { workspaces: Array<Record<string, unknown>>; defaultWorkspaceId?: string };
    assert.equal(catalog.defaultWorkspaceId, workspace.workspaceId);
    assert.deepEqual(catalog.workspaces, [{ id: workspace.workspaceId, label: "private-project", activeSessions: 1, lastSeenAt: catalog.workspaces[0]?.lastSeenAt }]);
    assert.equal(typeof catalog.workspaces[0]?.lastSeenAt, "number");
    assert.equal(JSON.stringify(catalog).includes(workspace.cwd), false, "absolute paths are never exposed in browser summaries");
    assert.equal(JSON.stringify(catalog).includes(service.controlToken), false, "control credentials never enter browser data");

    const fallback = await fetch(`${endpoint(service.url)}/api/snapshot?token=${browserToken(service.url)}`);
    assert.equal(fallback.status, 200, "the default workspace is selected when the query is omitted");
    assert.equal((await fallback.json() as { cursor: number }).cursor, 0);
    const unknown = await fetch(`${endpoint(service.url)}/api/snapshot?workspace=not-a-workspace&token=${browserToken(service.url)}`);
    assert.equal(unknown.status, 404, "an explicit unknown workspace never falls through to the default");

    const heartbeat = await control(service, "/internal/heartbeat", { clientId: workspace.clientId });
    assert.equal(heartbeat.status, 200);
    const unknownHeartbeat = await control(service, "/internal/heartbeat", { clientId: "unknown-client" });
    assert.equal(unknownHeartbeat.status, 404);
    const unregister = await control(service, "/internal/unregister", { clientId: workspace.clientId });
    assert.equal(unregister.status, 204);
    const duplicateUnregister = await control(service, "/internal/unregister", { clientId: workspace.clientId });
    assert.equal(duplicateUnregister.status, 204, "unregister is idempotent");
    assert.equal(service.clientCount(), 0);
  } finally {
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the detached service dependency graph imports under native Node TypeScript stripping", () => {
  const moduleUrl = new URL("../src/service/host.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(moduleUrl)})`,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, `Native Node could not load the service graph: ${result.stderr || result.stdout}`);
});

test("same-workspace clients detach independently and a shared service stays alive", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-clients-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, sweepMs: 60_000 });
  const first = registration(agentDir, "workspace", "client-first", "session-first");
  const second = { ...first, clientId: "client-second", sessionId: "session-second" };
  try {
    assert.equal((await control(service, "/internal/register", first)).status, 200);
    assert.equal((await control(service, "/internal/register", second)).status, 200);
    assert.equal(service.clientCount(), 2);

    assert.equal((await control(service, "/internal/unregister", { clientId: first.clientId })).status, 204);
    assert.equal(service.clientCount(), 1);
    const catalogResponse = await fetch(`${endpoint(service.url)}/api/workspaces?token=${browserToken(service.url)}`);
    const catalog = await catalogResponse.json() as { workspaces: Array<{ activeSessions: number }> };
    assert.equal(catalog.workspaces[0]?.activeSessions, 1, "closing one Pi removes only that attachment");
    const stillServing = await fetch(`${endpoint(service.url)}/api/workspaces?token=${browserToken(service.url)}`);
    assert.equal(stillServing.status, 200, "the detached daemon remains available to its other Pi client");
  } finally {
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a heartbeat does not steal the dashboard's default workspace", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-default-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, sweepMs: 60_000 });
  const first = registration(agentDir, "alpha", "client-alpha");
  const second = registration(agentDir, "beta", "client-beta");
  const catalog = async (): Promise<{ defaultWorkspaceId?: string }> => {
    const response = await fetch(`${endpoint(service.url)}/api/workspaces?token=${browserToken(service.url)}`);
    return await response.json() as { defaultWorkspaceId?: string };
  };
  try {
    assert.equal((await control(service, "/internal/register", first)).status, 200);
    assert.equal((await control(service, "/internal/register", second)).status, 200);
    assert.equal((await catalog()).defaultWorkspaceId, second.workspaceId);
    assert.equal((await control(service, "/internal/heartbeat", { clientId: first.clientId })).status, 200);
    assert.equal((await catalog()).defaultWorkspaceId, second.workspaceId, "liveness refresh does not make the default selection oscillate among Pi clients");
  } finally {
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("workspace registrations follow workspaceHash case identity on Windows", { skip: process.platform !== "win32" }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-case-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, sweepMs: 60_000 });
  const first = registration(agentDir, "CaseSensitiveOnDisk", "client-case-first", "session-case-first");
  const differentlyCased = {
    ...first,
    clientId: "client-case-second",
    sessionId: "session-case-second",
    cwd: first.cwd.toUpperCase(),
  };
  const sameClientWithDifferentCase = { ...differentlyCased, clientId: first.clientId, sessionId: first.sessionId };
  try {
    assert.equal((await control(service, "/internal/register", first)).status, 200);
    assert.equal((await control(service, "/internal/register", differentlyCased)).status, 200, "a second Pi using different path casing shares the same workspace store");
    assert.equal((await control(service, "/internal/register", sameClientWithDifferentCase)).status, 200, "an idempotent re-registration compares cwd by workspace identity");
    assert.equal(service.clientCount(), 2);
  } finally {
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("bus ingestion is workspace-scoped and file/bus duplicates occupy one event row", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-ingest-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, sweepMs: 60_000 });
  const alpha = registration(agentDir, "alpha", "client-alpha", "session-alpha");
  const beta = registration(agentDir, "beta", "client-beta", "session-beta");
  try {
    const fileEvent = event(alpha.workspaceId, "file-and-bus", 1);
    const logDir = join(agentDir, "pi-persona", "flow", alpha.workspaceId);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "producer.jsonl"), `${JSON.stringify(fileEvent)}\n`);
    assert.equal((await control(service, "/internal/register", alpha)).status, 200);
    assert.equal((await control(service, "/internal/register", beta)).status, 200);

    const busOnlyEvent = event(alpha.workspaceId, "bus-only", 1);
    const foreignEvent = event(beta.workspaceId, "foreign-to-alpha", 1);
    const ingest = await control(service, "/internal/ingest", {
      clientId: alpha.clientId,
      events: [fileEvent, busOnlyEvent, foreignEvent],
    });
    assert.equal(ingest.status, 200);
    assert.deepEqual(await ingest.json(), { accepted: 1, rejected: 2 });

    const alphaSnapshot = await fetch(`${endpoint(service.url)}/api/snapshot?workspace=${alpha.workspaceId}&token=${browserToken(service.url)}`);
    const alphaData = await alphaSnapshot.json() as { cursor: number; state: { agents: Record<string, unknown>; instances: Record<string, unknown> } };
    assert.equal(alphaData.cursor, 2, "one file event and one bus-only event; duplicate bus copy is ignored");
    assert.equal(Object.keys(alphaData.state.instances).length, 2);

    const betaSnapshot = await fetch(`${endpoint(service.url)}/api/snapshot?workspace=${beta.workspaceId}&token=${browserToken(service.url)}`);
    const betaData = await betaSnapshot.json() as { cursor: number; state: { instances: Record<string, unknown> } };
    assert.equal(betaData.cursor, 0, "foreign-workspace ingestion is never imported into another store");
    assert.equal(Object.keys(betaData.state.instances).length, 0);
  } finally {
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("private request body limits distinguish ordinary control from bounded event batches", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-limits-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, sweepMs: 60_000 });
  try {
    const oversizedControl = await control(service, "/internal/register", {
      ...registration(agentDir, "large", "client-large"),
      padding: "x".repeat(17 * 1024),
    });
    assert.equal(oversizedControl.status, 413, "ordinary internal operations have a 16 KiB cap");

    const oversizedBatch = await control(service, "/internal/ingest", {
      clientId: "client-large",
      events: ["x".repeat(2 * 1024 * 1024)],
    });
    assert.equal(oversizedBatch.status, 413, "event batches use their separate 2 MiB cap");
  } finally {
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("active workspaces are never evicted, while inactive workspace stores are bounded", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-cap-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, sweepMs: 60_000, maxWorkspaces: 1 });
  const first = registration(agentDir, "first", "client-first");
  const second = registration(agentDir, "second", "client-second");
  try {
    assert.equal((await control(service, "/internal/register", first)).status, 200);
    assert.equal((await control(service, "/internal/register", second)).status, 503, "an active workspace is not evicted to make room");
    assert.equal((await control(service, "/internal/unregister", { clientId: first.clientId })).status, 204);
    assert.equal((await control(service, "/internal/register", second)).status, 200, "the inactive least-recent store is evicted to honor the cap");
    const catalogResponse = await fetch(`${endpoint(service.url)}/api/workspaces?token=${browserToken(service.url)}`);
    const catalog = await catalogResponse.json() as { workspaces: Array<{ id: string }> };
    assert.deepEqual(catalog.workspaces.map((workspace) => workspace.id), [second.workspaceId]);
  } finally {
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the global client cap admits renewals, rejects new clients without workspace side effects, then recovers", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-client-cap-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, sweepMs: 60_000, maxClients: 1 });
  const first = registration(agentDir, "first", "client-first");
  const second = registration(agentDir, "second", "client-second");
  try {
    assert.equal((await control(service, "/internal/register", first)).status, 200);
    assert.equal((await control(service, "/internal/register", first)).status, 200, "idempotent registration is allowed at the cap");
    assert.equal((await control(service, "/internal/heartbeat", { clientId: first.clientId })).status, 200, "heartbeats are allowed at the cap");
    assert.equal((await control(service, "/internal/register", second)).status, 503, "a new client is rejected at the global cap");
    assert.equal(service.clientCount(), 1);

    const catalogResponse = await fetch(`${endpoint(service.url)}/api/workspaces?token=${browserToken(service.url)}`);
    const catalog = await catalogResponse.json() as { workspaces: Array<{ id: string; activeSessions: number; lastSeenAt: number }>; defaultWorkspaceId?: string };
    assert.deepEqual(catalog.workspaces, [{ id: first.workspaceId, label: "first", activeSessions: 1, lastSeenAt: catalog.workspaces[0]?.lastSeenAt }]);
    assert.equal(catalog.defaultWorkspaceId, first.workspaceId, "a rejected registration does not change the default workspace");

    assert.equal((await control(service, "/internal/unregister", { clientId: first.clientId })).status, 204);
    assert.equal((await control(service, "/internal/register", second)).status, 200, "unregistering frees a client slot");
    assert.equal(service.clientCount(), 1);
  } finally {
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a missed heartbeat expires its lease and immediately clears the active workspace count", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-lease-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, leaseMs: 40, sweepMs: 5 });
  const attached = registration(agentDir, "lease", "client-lease");
  try {
    assert.equal((await control(service, "/internal/register", attached)).status, 200);
    assert.equal(service.clientCount(), 1);
    await waitFor(() => service.clientCount() === 0, "the expired lease should be removed by the lifecycle sweep");
    const catalogResponse = await fetch(`${endpoint(service.url)}/api/workspaces?token=${browserToken(service.url)}`);
    const catalog = await catalogResponse.json() as { workspaces: Array<{ activeSessions: number }> };
    assert.equal(catalog.workspaces[0]?.activeSessions, 0);
  } finally {
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("an open authenticated browser stream prevents idle shutdown until it disconnects", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-sse-idle-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60 });
  const attached = registration(agentDir, "review", "client-review");
  let stream: http.IncomingMessage | undefined;
  let serviceClosed = false;
  void service.closed.then(() => { serviceClosed = true; });
  try {
    assert.equal((await control(service, "/internal/register", attached)).status, 200);
    assert.equal((await control(service, "/internal/unregister", { clientId: attached.clientId })).status, 204);
    stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get(`${endpoint(service.url)}/api/stream?workspace=${attached.workspaceId}&token=${browserToken(service.url)}`, resolve);
      request.once("error", reject);
    });
    assert.equal(stream.statusCode, 200);
    const connectedHealth = await fetch(`${endpoint(service.url)}/health`).then((response) => response.json()) as { clients: number };
    assert.equal(connectedHealth.clients, 1, "the server accounts for the open SSE connection");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(serviceClosed, false, "the open dashboard SSE client keeps the daemon available beyond its idle window");

    // Destroy the actual socket. Undici's reader.cancel()/AbortController can leave its pooled
    // connection open, which tests fetch implementation behavior rather than server disconnect.
    stream.destroy();
    await waitFor(() => serviceClosed, "idle shutdown after the browser SSE client disconnects");
  } finally {
    stream?.destroy();
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("an explicit unknown stream workspace returns 404 even when the stream limit is full", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-stream-cap-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 60_000, maxStreamClients: 1 });
  const attached = registration(agentDir, "known", "client-known");
  let stream: http.IncomingMessage | undefined;
  try {
    assert.equal((await control(service, "/internal/register", attached)).status, 200);
    stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get(`${endpoint(service.url)}/api/stream?workspace=${attached.workspaceId}&token=${browserToken(service.url)}`, resolve);
      request.once("error", reject);
    });
    assert.equal(stream.statusCode, 200);
    const unknown = await fetch(`${endpoint(service.url)}/api/stream?workspace=unknown-workspace&token=${browserToken(service.url)}`);
    assert.equal(unknown.status, 404, "workspace lookup remains authoritative before the global stream cap");
    await unknown.body?.cancel();
  } finally {
    stream?.destroy();
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("an idle daemon closes only after its configured quiet window and reports full cleanup", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-idle-"));
  const service = await startSharedService({ agentDir, port: 0, idleMs: 35 });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      service.closed,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("service did not close while idle")), 1_000); }),
    ]);
    if (timeout) clearTimeout(timeout);
    await service.close();
    assert.equal(service.clientCount(), 0);
  } finally {
    if (timeout) clearTimeout(timeout);
    await service.close();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("an occupied requested port falls back to a free loopback port", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-shared-port-"));
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  let service: Awaited<ReturnType<typeof startSharedService>> | undefined;
  try {
    service = await startSharedService({ agentDir, port: address.port, idleMs: 60_000, sweepMs: 60_000 });
    const actualPort = Number(new URL(service.url).port);
    assert.notEqual(actualPort, address.port, "the conflicting requested port is not reported as usable");
    const health = await fetch(`${endpoint(service.url)}/health`);
    assert.equal(health.status, 200);
  } finally {
    await service?.close();
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    rmSync(agentDir, { recursive: true, force: true });
  }
});
