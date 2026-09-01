import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

import { LEGACY_TELEMETRY_EVENT_NAME, TELEMETRY_EVENT_NAME } from "../shared/protocol.ts";
import { EventStore } from "./event-store.ts";
import { startServer, type FlowServer } from "./server.ts";
import { TelemetryTailer, workspaceHash } from "./tailer.ts";

const DEFAULT_PORT = 7874;

/** Pi extension entry point for the file-backed, explicit telemetry dashboard. */
export default function piPersonaFlow(pi: ExtensionAPI): void {
  let store: EventStore | undefined;
  let tailer: TelemetryTailer | undefined;
  let server: FlowServer | undefined;
  let unsubscribeTelemetry: (() => void) | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  let generation = 0;
  let port = resolvePort();

  function resolvePort(): number {
    const value = (process.env.PI_PERSONA_FLOW_PORT ?? "").trim();
    return /^\d+$/.test(value) ? Number(value) : DEFAULT_PORT;
  }

  function autostart(): boolean {
    if (pi.getFlag("flow") === true) return true;
    return /^(1|true|on|yes)$/i.test((process.env.PI_PERSONA_FLOW_AUTOSTART ?? "").trim());
  }

  function openBrowser(url: string): void {
    const { cmd, args } = browserLaunch(process.platform, url);
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  }

  async function startIfNeeded(): Promise<FlowServer | undefined> {
    if (server) return server;
    const thisGeneration = generation;
    const currentStore = store;
    if (!currentStore) return undefined;
    let candidate: FlowServer;
    try {
      candidate = await startServer({ port, store: currentStore });
    } catch {
      candidate = await startServer({ port: 0, store: currentStore });
    }
    if (thisGeneration !== generation || store !== currentStore) {
      await candidate.close();
      return undefined;
    }
    server = candidate;
    port = candidate.port;
    return candidate;
  }

  async function stopServer(): Promise<void> {
    const current = server;
    server = undefined;
    if (current) await current.close();
  }

  type SessionUi = {
    hasUI: boolean;
    ui: {
      notify(message: string, type?: "info" | "warning" | "error"): void;
      setStatus(key: string, text: string | undefined): void;
      setWidget?(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
    };
  };
  let sessionUi: SessionUi | undefined;

  function listeningHostPort(): string | undefined {
    if (!server) return undefined;
    try {
      const parsed = new URL(server.url);
      return `${parsed.hostname}:${parsed.port || String(server.port)}`;
    } catch {
      return `127.0.0.1:${server.port}`;
    }
  }

  function statusText(): string {
    // Runs on every ingested event, so it reads the graph in place instead of deep-copying it.
    const state = store?.peek();
    if (!state) return "flow stopped";
    const agents = Object.keys(state.agents).length;
    const peers = Object.keys(state.peers).length;
    // Host:port in the footer so `--flow` is not a mystery. Never a tokenless `http://…` —
    // that 401s. The clickable tokenized URL lives on the widget / notify / stdout line.
    const dashboard = listeningHostPort() ?? "stopped";
    return `flow ${dashboard} · ${agents} agents · ${peers} peers`;
  }

  function announceListening(url: string): void {
    const line = dashboardListeningLine(url);
    if (!sessionUi?.hasUI) {
      process.stdout.write(`${line}\n`);
      return;
    }
    try { sessionUi.ui.setStatus("flow", statusText()); } catch { /* UI may be unavailable */ }
    // Widget only — a toast of the same line stacks above the exocom row and duplicates it.
    try { sessionUi.ui.setWidget?.("flow", [line], { placement: "aboveEditor" }); } catch { /* older Pi / RPC */ }
  }

  function hideListening(): void {
    if (!sessionUi?.hasUI) return;
    try { sessionUi.ui.setWidget?.("flow", undefined); } catch { /* older Pi / RPC */ }
    try { sessionUi.ui.setStatus("flow", statusText()); } catch { /* UI may be unavailable */ }
  }

  pi.on("session_start", async (_event, ctx) => {
    generation += 1;
    const startupGeneration = generation;
    const previousServer = server;
    server = undefined;
    sessionUi = ctx;
    unsubscribeTelemetry?.();
    unsubscribeTelemetry = undefined;
    unsubscribeStatus?.();
    unsubscribeStatus = undefined;
    tailer?.stop();
    tailer = undefined;
    if (previousServer) await previousServer.close();
    if (generation !== startupGeneration) return;
    port = resolvePort();
    const currentGeneration = generation;
    const cwd = ctx.cwd;
    const workspaceId = workspaceHash(cwd);
    const nextStore = new EventStore();
    const nextTailer = new TelemetryTailer({ store: nextStore, workspaceId, cwd });
    store = nextStore;
    tailer = nextTailer;
    nextTailer.start();

    if (pi.events) {
      const ingest = (value: unknown): void => {
        if (generation === currentGeneration) nextTailer.ingest(value);
      };
      const unsubscribeV2 = pi.events.on(TELEMETRY_EVENT_NAME, ingest);
      const unsubscribeLegacy = pi.events.on(LEGACY_TELEMETRY_EVENT_NAME, ingest);
      unsubscribeTelemetry = () => { unsubscribeV2(); unsubscribeLegacy(); };
    }

    unsubscribeStatus = nextStore.subscribe(() => {
      if (!ctx.hasUI) return;
      try { ctx.ui.setStatus("flow", statusText()); } catch { /* UI may be unavailable during teardown */ }
    });
    if (ctx.hasUI) {
      try { ctx.ui.setStatus("flow", statusText()); } catch { /* UI may be unavailable during startup */ }
    }
    if (autostart()) {
      const started = await startIfNeeded();
      if (started && generation === currentGeneration) announceListening(started.url);
    }
  });

  // Keep the lifecycle hooks registered for Pi versions that expose them; all
  // graph data comes from the explicit telemetry contract, never tool heuristics.
  pi.on("session_info_changed", () => undefined);
  pi.on("turn_start", () => undefined);
  pi.on("before_agent_start", () => undefined);
  pi.on("tool_call", () => undefined);
  pi.on("tool_result", () => undefined);
  pi.on("agent_settled", () => undefined);

  pi.on("session_shutdown", async () => {
    generation += 1;
    unsubscribeTelemetry?.();
    unsubscribeTelemetry = undefined;
    unsubscribeStatus?.();
    unsubscribeStatus = undefined;
    tailer?.stop();
    tailer = undefined;
    await stopServer();
    hideListening();
    store = undefined;
    sessionUi = undefined;
  });

  // NOT "flow": pi-persona already owns /flow for running a flow (a DAG over strategies). It wins the
  // registration, so "/flow open" resolves to "run a flow named open" and this dashboard becomes
  // unreachable by command while still serving on its port. This package depends on pi-persona, so
  // it is the one that yields the name.
  pi.registerCommand("dashboard", {
    description: "Open the live telemetry dashboard",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "stop") {
        await stopServer();
        hideListening();
        if (ctx.hasUI) ctx.ui.notify("pi-persona-flow: dashboard stopped.", "info");
        return;
      }
      if (sub === "status") {
        const text = server ? dashboardListeningLine(server.url) : "flow dashboard stopped";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        else process.stdout.write(`${text}\n`);
        return;
      }
      const started = await startIfNeeded();
      if (!started) {
        if (ctx.hasUI) ctx.ui.notify("pi-persona-flow: no active session.", "error");
        return;
      }
      if (sub === "" || sub === "open" || sub === "serve") openBrowser(started.url);
      announceListening(started.url);
    },
  });

  pi.registerFlag("flow", {
    type: "boolean",
    default: false,
    description: "Auto-start the pi-persona-flow dashboard on session start",
  });
}

/** The line `--flow` and `/dashboard` put on screen: host, port, and the token that actually opens it. */
export function dashboardListeningLine(url: string): string {
  return `flow dashboard at ${url}`;
}

/** Never `cmd /c start`: cmd.exe re-parses `&` `|` `^` in the URL before `start` runs.
 *  Match Pi's own launcher — rundll32 on Windows, and always attach an error listener. */
export function browserLaunch(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}

export { EventStore, TelemetryTailer, workspaceHash };
export type { FlowServer } from "./server.ts";
