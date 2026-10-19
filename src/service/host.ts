import * as crypto from "node:crypto";

import { SHARED_SERVICE_PROTOCOL, type SharedServiceDescriptor } from "../../shared/workspaces.ts";
import { startServer, type FlowServer } from "../server.ts";
import { WorkspaceRegistry } from "./registry.ts";

export interface SharedServiceOptions {
  agentDir: string;
  port: number;
  idleMs?: number;
  leaseMs?: number;
  /** Maximum registered Pi sessions; defaults to 256 to keep registry memory bounded. */
  maxClients?: number;
  sweepMs?: number;
  maxWorkspaces?: number;
  staticDir?: string;
  heartbeatMs?: number;
  maxStreamClients?: number;
  maxStreamBufferBytes?: number;
}

export interface SharedService extends SharedServiceDescriptor {
  close(): Promise<void>;
  clientCount(): number;
  /** Resolves only after HTTP server, registry, and all workspace tailers have closed. */
  closed: Promise<void>;
}

/** Start one detached, local daemon that owns event stores/tailers for all attached Pi workspaces. */
export async function startSharedService(options: SharedServiceOptions): Promise<SharedService> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new RangeError("port must be between 0 and 65535");
  const idleMs = options.idleMs ?? 60_000;
  const sweepMs = options.sweepMs ?? 5_000;
  if (!Number.isFinite(idleMs) || idleMs < 1) throw new RangeError("idleMs must be positive");
  if (!Number.isFinite(sweepMs) || sweepMs < 1) throw new RangeError("sweepMs must be positive");

  const serviceId = crypto.randomUUID();
  const controlToken = crypto.randomBytes(32).toString("base64url");
  let server: FlowServer | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let idleSince = Date.now();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const checkIdle = (): void => {
    if (closing || !server) return;
    const active = registry.clientCount > 0 || server.clientCount() > 0;
    if (active) {
      idleSince = 0;
      return;
    }
    if (idleSince === 0) idleSince = Date.now();
    if (Date.now() - idleSince >= idleMs) void close();
  };

  const registry = new WorkspaceRegistry({
    agentDir: options.agentDir,
    leaseMs: options.leaseMs,
    maxClients: options.maxClients,
    maxWorkspaces: options.maxWorkspaces,
    onClientCountChanged: checkIdle,
  });

  const serverOptions = {
    port: options.port,
    workspaceSource: registry,
    controlPlane: registry,
    controlToken,
    serviceId,
    staticDir: options.staticDir,
    heartbeatMs: options.heartbeatMs,
    staleSweepMs: sweepMs,
    maxStreamClients: options.maxStreamClients,
    maxStreamBufferBytes: options.maxStreamBufferBytes,
  };
  try {
    try {
      server = await startServer(serverOptions);
    } catch (error) {
      if (options.port === 0 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      // A configured port is a preference, not a single point of failure: another Pi or local app
      // may already own it. Retry only the address-collision case on an OS-assigned loopback port.
      server = await startServer({ ...serverOptions, port: 0 });
    }
  } catch (error) {
    registry.close();
    resolveClosed();
    throw error;
  }

  const lifecycleSweep = setInterval(() => {
    if (closing) return;
    registry.sweep();
    checkIdle();
  }, Math.min(sweepMs, idleMs));
  lifecycleSweep.unref?.();

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(lifecycleSweep);
    closePromise = (async () => {
      try {
        await server!.close();
      } finally {
        registry.close();
        resolveClosed();
      }
    })();
    return closePromise;
  };

  return {
    protocol: SHARED_SERVICE_PROTOCOL,
    serviceId,
    pid: process.pid,
    url: server.url,
    controlToken,
    startedAt: Date.now(),
    close,
    clientCount: () => registry.clientCount,
    closed,
  };
}
