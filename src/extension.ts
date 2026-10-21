import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { LEGACY_TELEMETRY_EVENT_NAME, parseTelemetryEvent, TELEMETRY_EVENT_NAME } from "../shared/protocol.ts";
import { connectFlowService } from "./service/client.ts";
import { workspaceHash } from "./tailer.ts";
import { isSupportedPiVersion, MIN_PI_VERSION } from "./pi-compat.ts";
import { FLOW_SETTINGS_CHANNEL, readFlowSettings } from "./settings.ts";

type Connection = Awaited<ReturnType<typeof connectFlowService>>;
export interface FlowExtensionOptions {
  connect?: typeof connectFlowService;
  heartbeatMs?: number;
  flushMs?: number;
  retryMs?: number;
}

/** Thin Pi attachment: the detached service, not the first Pi, owns the viewer. */
export default function piPersonaFlow(pi: ExtensionAPI): void { createExtension(pi); }

export function createExtension(pi: ExtensionAPI, options: FlowExtensionOptions = {}): void {
  if (!isSupportedPiVersion(VERSION)) throw new Error(`pi-persona-flow requires Pi ${MIN_PI_VERSION}+ (found ${VERSION}).`);
  if (process.env.PI_PERSONA_LEG === "1" || process.env.PI_PERSONA_CHILD === "1") return;
  const agentDir = process.env.PI_AGENT_DIR || getAgentDir();
  const settingsWarnings: string[] = [];
  const flowSettings = readFlowSettings(agentDir, process.env, settingsWarnings);
  const connect = options.connect ?? connectFlowService;
  const heartbeatMs = options.heartbeatMs ?? 5_000;
  const flushMs = options.flushMs ?? 10;
  const retryMs = options.retryMs ?? 1_000;
  type Attachment = {
    ctx: ExtensionContext;
    workspaceId: string;
    controller: AbortController;
    closed: boolean;
    healthy: boolean;
    connection?: Connection;
    opening?: Promise<Connection | undefined>;
    timer?: ReturnType<typeof setInterval>;
    retry?: ReturnType<typeof setTimeout>;
    retryDelay: number;
    flush?: ReturnType<typeof setTimeout>;
    heartbeatTask?: Promise<void>;
    publishing: boolean;
    inFlight: number;
    delivery?: Promise<void>;
    queue: unknown[];
    bytes: number;
    unsubscribe: Array<() => void>;
    diagnostics: Set<string>;
    lastStatus?: string;
  };
  let active: Attachment | undefined;
  let generation = 0;
  let settingsWarningsReported = false;
  const disabled = (): boolean => pi.getFlag("no-flow") === true;
  let unsubscribeSettings: (() => void) | undefined;
  const collectSettings = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const add = (value as { add?: unknown }).add;
    if (typeof add !== "function") return;
    try {
      add.call(value, "flow", {
        flowEnabled: flowSettings.flowEnabled,
        flowPort: flowSettings.flowPort,
        flowIdleMs: flowSettings.flowIdleMs,
      });
    } catch {
      /* A companion settings view is optional and must not break Flow attachment. */
    }
  };
  const registerSettingsContribution = (): void => {
    if (unsubscribeSettings) return;
    unsubscribeSettings = pi.events.on(FLOW_SETTINGS_CHANNEL, collectSettings);
  };
  const unregisterSettingsContribution = (): void => {
    const unsubscribe = unsubscribeSettings;
    unsubscribeSettings = undefined;
    unsubscribe?.();
  };
  registerSettingsContribution();

  function report(ctx: ExtensionContext, text: string, warning = false, automatic = false): void {
    if (ctx.hasUI) { try { ctx.ui.notify(text, warning ? "warning" : "info"); } catch { /* UI teardown */ } }
    else (automatic ? process.stderr : process.stdout).write(`${text}\n`);
  }
  function warn(a: Attachment, key: string, text: string): void {
    if (a.closed || active !== a || a.diagnostics.has(key)) return;
    if (a.diagnostics.size < 16) a.diagnostics.add(key);
    report(a.ctx, `pi-persona-flow: ${text}`, true, true);
  }
  function status(a: Attachment): void {
    if (a.closed || active !== a || !a.ctx.hasUI) return;
    const value = a.connection && a.healthy
      ? `flow ${new URL(a.connection.url).host} · workspace ${a.workspaceId.slice(0, 8)}`
      : "flow unavailable · reconnecting automatically";
    if (value === a.lastStatus) return;
    try { a.ctx.ui.setStatus("flow", value); a.lastStatus = value; } catch { /* UI teardown */ }
  }
  function announce(a: Attachment, automatic: boolean): void {
    if (a.closed || active !== a || !a.connection || !a.healthy) return;
    const line = dashboardListeningLine(a.connection.url);
    status(a);
    if (!a.ctx.hasUI) { report(a.ctx, line, false, automatic); return; }
    try { a.ctx.ui.setWidget("flow", [line], { placement: "aboveEditor" }); } catch { /* RPC / UI teardown */ }
  }
  function scheduleFlush(a: Attachment): void {
    if (a.closed || active !== a || !a.healthy || !a.connection || a.publishing || a.flush || a.queue.length === 0) return;
    a.flush = setTimeout(() => { delete a.flush; void flush(a); }, flushMs);
    a.flush.unref();
  }
  function scheduleRetry(a: Attachment): void {
    if (a.closed || active !== a || a.healthy || a.opening || a.retry) return;
    a.retry = setTimeout(() => {
      delete a.retry;
      void open(a).then((connection) => { if (connection) announce(a, true); });
    }, a.retryDelay);
    a.retry.unref();
    a.retryDelay = Math.min(a.retryDelay * 2, 30_000);
  }
  function unavailable(a: Attachment, text: string): void {
    if (a.closed || active !== a) return;
    a.healthy = false;
    if (a.timer) { clearInterval(a.timer); delete a.timer; }
    if (a.ctx.hasUI) { try { a.ctx.ui.setWidget("flow", undefined); } catch { /* UI teardown */ } }
    warn(a, "connection", text);
    status(a);
    scheduleRetry(a);
  }
  async function deliver(connection: Connection, batch: readonly unknown[]): Promise<void> {
    // A lost response is ambiguous, not proof the server rejected the events. IDs are immutable
    // and the service deduplicates, so one bounded retry preserves bus-only producers safely.
    try { await connection.publish(batch); }
    catch { await new Promise((done) => setTimeout(done, 50)); await connection.publish(batch); }
  }
  async function flush(a: Attachment): Promise<void> {
    if (a.closed || active !== a || !a.connection || a.publishing || !a.healthy || a.queue.length === 0) return;
    const batch = a.queue;
    // Pending and in-flight events share one budget, so a failed batch can always be retained.
    const batchBytes = a.bytes;
    a.queue = []; a.inFlight = batch.length; a.publishing = true;
    const connection = a.connection;
    const delivery = deliver(connection, batch).then(() => {
      a.bytes -= batchBytes;
    }, () => {
      a.inFlight = 0;
      a.queue.unshift(...batch);
      unavailable(a, "live telemetry delivery failed; reconnecting automatically. Pending events are retained within the bounded queue; file-backed history remains available.");
    }).finally(() => {
      delete a.delivery; a.inFlight = 0; a.publishing = false; scheduleFlush(a);
    });
    a.delivery = delivery;
    await delivery;
  }
  function subscribe(a: Attachment): void {
    const ingest = (value: unknown): void => {
      if (a.closed || active !== a) return;
      const parsed = parseTelemetryEvent(value);
      if (!parsed || parsed.workspaceId !== a.workspaceId) return;
      const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
      if (a.queue.length + a.inFlight >= 256 || a.bytes + bytes > 1_048_576) {
        warn(a, "overload", "live telemetry queue is full; excess bus events were dropped. File-backed history remains available.");
        return;
      }
      a.queue.push(parsed); a.bytes += bytes;
      scheduleFlush(a);
    };
    a.unsubscribe.push(pi.events.on(TELEMETRY_EVENT_NAME, ingest), pi.events.on(LEGACY_TELEMETRY_EVENT_NAME, ingest));
  }
  async function heartbeat(a: Attachment): Promise<void> {
    if (a.closed || active !== a || !a.connection || !a.healthy || a.heartbeatTask) return;
    const task = a.connection.heartbeat().catch(() => {
      unavailable(a, "shared service is unavailable; reconnecting automatically. File-backed history remains available.");
    }).finally(() => { delete a.heartbeatTask; });
    a.heartbeatTask = task;
    await task;
  }
  async function detach(a: Attachment | undefined): Promise<void> {
    if (!a || a.closed) return;
    a.closed = true;
    a.controller.abort();
    if (a.timer) clearInterval(a.timer);
    if (a.retry) clearTimeout(a.retry);
    if (a.flush) clearTimeout(a.flush);
    for (const unsubscribe of a.unsubscribe) unsubscribe();
    if (a.ctx.hasUI) {
      try { a.ctx.ui.setWidget("flow", undefined); a.ctx.ui.setStatus("flow", undefined); } catch { /* UI teardown */ }
    }
    // A cancelled connect may finish late. open() closes that result before resolving.
    await a.opening?.catch(() => undefined);
    // Keep bus-only terminal events too. Client HTTP deadlines bound this join; no unbounded
    // producer shutdown wait, and no publish/unregister race against an existing request.
    const deliveryFailed = (): void => report(a.ctx, "pi-persona-flow: final live telemetry delivery failed; file-backed history remains available.", true, true);
    await a.heartbeatTask;
    await a.delivery?.catch(deliveryFailed);
    const finalBatch = a.queue;
    a.queue = []; a.bytes = 0;
    if (a.connection && a.healthy && finalBatch.length) await deliver(a.connection, finalBatch).catch(deliveryFailed);
    await a.connection?.close().catch(() => undefined);
  }
  function attach(ctx: ExtensionContext): Promise<Connection | undefined> {
    if (active && !active.closed) return open(active);
    const a: Attachment = {
      ctx, workspaceId: workspaceHash(ctx.cwd), controller: new AbortController(), closed: false,
      healthy: false, publishing: false, inFlight: 0, queue: [], bytes: 0, retryDelay: retryMs,
      unsubscribe: [], diagnostics: new Set(),
    };
    active = a;
    subscribe(a);
    return open(a);
  }
  function open(a: Attachment): Promise<Connection | undefined> {
    if (a.closed || active !== a) return Promise.resolve(undefined);
    if (a.opening) return a.opening;
    if (a.healthy) return Promise.resolve(a.connection);
    if (a.retry) { clearTimeout(a.retry); delete a.retry; }
    const opening = (async () => {
      try {
        // Join the old client's bounded requests before unregistering it. Recovery stays in this
        // attachment so queued events, subscriptions, and session cancellation keep their identity.
        await a.heartbeatTask;
        await a.delivery;
        const previous = a.connection;
        delete a.connection;
        await previous?.close().catch(() => undefined);
        if (a.closed || active !== a) return undefined;
        const connection = await connect({
          agentDir, cwd: a.ctx.cwd,
          sessionId: a.ctx.sessionManager.getSessionId(),
          port: flowSettings.flowPort,
          idleMs: flowSettings.flowIdleMs,
          signal: a.controller.signal,
        });
        if (a.closed || active !== a) { await connection.close(); return undefined; }
        a.connection = connection; a.healthy = true;
        a.retryDelay = retryMs;
        a.diagnostics.delete("connection");
        a.timer = setInterval(() => { void heartbeat(a); }, heartbeatMs);
        a.timer.unref();
        scheduleFlush(a);
        return connection;
      } catch (error) {
        const detail = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 600) : "unknown startup error";
        unavailable(a, `could not attach to the shared service: ${detail}. Retrying automatically.`);
        return undefined;
      }
    })();
    a.opening = opening;
    void opening.then(() => { if (a.opening === opening) delete a.opening; scheduleRetry(a); });
    return opening;
  }

  pi.on("session_start", async (_event, ctx) => {
    registerSettingsContribution();
    const epoch = ++generation;
    const previous = active; active = undefined;
    await detach(previous);
    if (!settingsWarningsReported && settingsWarnings.length > 0) {
      settingsWarningsReported = true;
      report(ctx, `pi-persona-flow: ${settingsWarnings.join(" ")}`, true, true);
    }
    if (generation !== epoch || disabled() || !flowSettings.flowEnabled) return;
    await attach(ctx);
    if (generation === epoch && active) announce(active, true);
  });
  pi.on("session_shutdown", async () => {
    ++generation;
    unregisterSettingsContribution();
    const previous = active; active = undefined;
    await detach(previous);
  });
  pi.registerCommand("dashboard", {
    description: "Open the shared workspace telemetry dashboard",
    handler: async (args, ctx) => {
      if (disabled()) { report(ctx, "pi-persona-flow: disabled for this run by --no-flow."); return; }
      const sub = (args ?? "").trim().toLowerCase();
      if (!["", "open", "serve", "status", "stop"].includes(sub)) { report(ctx, "Usage: /dashboard [open|serve|status|stop]", true); return; }
      if (sub === "stop") {
        ++generation;
        const previous = active; active = undefined;
        await detach(previous);
        report(ctx, "pi-persona-flow: detached this session; the shared dashboard remains available.");
        return;
      }
      if (sub === "status") {
        report(ctx, active?.connection && active.healthy ? dashboardListeningLine(active.connection.url) : "flow dashboard detached or unavailable for this run");
        return;
      }
      const epoch = generation;
      const connection = await attach(ctx);
      if (!connection || generation !== epoch || active?.connection !== connection) return;
      if (sub === "" || sub === "open") {
        const { cmd, args: browserArgs } = browserLaunch(process.platform, connection.url);
        spawn(cmd, browserArgs, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => undefined).unref();
      }
      announce(active, false);
    },
  });
  pi.registerFlag("no-flow", {
    type: "boolean", default: false,
    description: "Do not attach this run to the shared pi-persona-flow dashboard",
  });
}

export function dashboardListeningLine(url: string): string { return `flow dashboard at ${url}`; }
/** No cmd.exe reparsing of URL metacharacters; errors are handled by the caller. */
export function browserLaunch(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}
export { EventStore } from "./event-store.ts";
export { TelemetryTailer, workspaceHash } from "./tailer.ts";
export type { FlowServer } from "./server.ts";
