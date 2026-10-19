import * as path from "node:path";

import { parseTelemetryEvent, type TelemetryEvent } from "../../shared/protocol.ts";
import type { WorkspaceCatalog, WorkspaceRegistration, WorkspaceSummary } from "../../shared/workspaces.ts";
import { EventStore } from "../event-store.ts";
import { TelemetryTailer, workspaceHash } from "../tailer.ts";

export interface WorkspaceSource {
  catalog(): WorkspaceCatalog;
  resolve(workspaceId?: string): EventStore | undefined;
  sweepStale(): number;
}

export interface WorkspaceRegistryOptions {
  agentDir: string;
  leaseMs?: number;
  maxClients?: number;
  maxWorkspaces?: number;
  now?: () => number;
  /** Injectable only to make process-liveness edge cases deterministic in tests. */
  isPidAlive?: (pid: number) => boolean;
  onClientCountChanged?: () => void;
}

export class WorkspaceRegistryError extends Error {
  readonly statusCode: 400 | 404 | 409 | 503;

  constructor(statusCode: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = "WorkspaceRegistryError";
    this.statusCode = statusCode;
  }
}

interface ClientLease {
  registration: WorkspaceRegistration;
  expiresAt: number;
}

interface WorkspaceState {
  id: string;
  cwd: string;
  label: string;
  lastSeenAt: number;
  clients: Set<string>;
  store: EventStore;
  tailer: TelemetryTailer;
}

/** Per-agentDir workspace ownership, leases, and the store/tailer pair for each retained workspace. */
export class WorkspaceRegistry implements WorkspaceSource {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly clients = new Map<string, ClientLease>();
  private readonly agentDir: string;
  private readonly leaseMs: number;
  private readonly maxClients: number;
  private readonly maxWorkspaces: number;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly onClientCountChanged?: () => void;
  private defaultWorkspaceId: string | undefined;
  private closed = false;

  constructor(options: WorkspaceRegistryOptions) {
    if (!path.isAbsolute(options.agentDir)) throw new TypeError("agentDir must be absolute");
    this.agentDir = path.resolve(options.agentDir);
    this.leaseMs = options.leaseMs ?? 20_000;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs < 1) throw new RangeError("leaseMs must be positive");
    this.maxClients = options.maxClients ?? 256;
    if (!Number.isSafeInteger(this.maxClients) || this.maxClients < 1) throw new RangeError("maxClients must be positive");
    this.maxWorkspaces = options.maxWorkspaces ?? 32;
    if (!Number.isSafeInteger(this.maxWorkspaces) || this.maxWorkspaces < 1) throw new RangeError("maxWorkspaces must be positive");
    this.now = options.now ?? Date.now;
    this.isPidAlive = options.isPidAlive ?? processIsAlive;
    this.onClientCountChanged = options.onClientCountChanged;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get workspaceCount(): number {
    return this.workspaces.size;
  }

  register(value: unknown): { workspaceId: string } {
    if (this.closed) throw new WorkspaceRegistryError(503, "service is closing");
    const registration = validateRegistration(value);
    const existing = this.clients.get(registration.clientId);
    if (existing) {
      if (!sameRegistration(existing.registration, registration)) {
        throw new WorkspaceRegistryError(409, "clientId is already attached to another workspace/session");
      }
      this.touch(existing, this.workspaces.get(registration.workspaceId)!);
      return { workspaceId: registration.workspaceId };
    }
    if (this.clients.size >= this.maxClients) throw new WorkspaceRegistryError(503, "maximum active client registrations reached");

    let workspace = this.workspaces.get(registration.workspaceId);
    if (!workspace) {
      this.makeRoom();
      workspace = this.createWorkspace(registration);
    } else if (!sameWorkspacePath(workspace.cwd, registration.cwd)) {
      // The hash is the identity, but keep a canonical path equality check against accidental
      // collision or a malformed path normalization rather than silently rebinding this store.
      throw new WorkspaceRegistryError(409, "workspaceId is already bound to a different path");
    }

    const lease: ClientLease = { registration, expiresAt: this.now() + this.leaseMs };
    this.clients.set(registration.clientId, lease);
    workspace.clients.add(registration.clientId);
    workspace.lastSeenAt = this.now();
    this.defaultWorkspaceId = workspace.id;
    this.onClientCountChanged?.();
    return { workspaceId: workspace.id };
  }

  heartbeat(clientId: string): boolean {
    const lease = this.clients.get(clientId);
    if (!lease) return false;
    const workspace = this.workspaces.get(lease.registration.workspaceId);
    if (!workspace) {
      this.clients.delete(clientId);
      this.onClientCountChanged?.();
      return false;
    }
    if (lease.expiresAt <= this.now() || !this.isPidAlive(lease.registration.pid)) {
      this.removeClient(clientId, false);
      return false;
    }
    this.touch(lease, workspace, false);
    return true;
  }

  /** Idempotent: closing one Pi removes only its client lease, never its shared service. */
  unregister(clientId: string): boolean {
    return this.removeClient(clientId, true);
  }

  /** Expire crashed or silent clients. Permission/unknown process errors are treated as alive. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [clientId, lease] of this.clients) {
      if (lease.expiresAt <= now || !this.isPidAlive(lease.registration.pid)) {
        if (this.removeClient(clientId, false)) removed += 1;
      }
    }
    return removed;
  }

  ingest(clientId: string, events: readonly unknown[]): { accepted: number; rejected: number } {
    const lease = this.clients.get(clientId);
    if (!lease) throw new WorkspaceRegistryError(404, "client registration not found");
    const workspace = this.workspaces.get(lease.registration.workspaceId);
    if (!workspace) throw new WorkspaceRegistryError(404, "workspace registration not found");
    let accepted = 0;
    let rejected = 0;
    for (const value of events) {
      // Import on demand so the protocol parser remains the sole authority for both bus and file data.
      const event = parseEvent(value);
      if (!event || event.workspaceId !== workspace.id) {
        rejected += 1;
        continue;
      }
      if (workspace.store.append(event) === undefined) rejected += 1;
      else accepted += 1;
    }
    return { accepted, rejected };
  }

  catalog(): WorkspaceCatalog {
    const workspaces: WorkspaceSummary[] = [...this.workspaces.values()]
      .sort((a, b) => Number(b.clients.size > 0) - Number(a.clients.size > 0) || b.lastSeenAt - a.lastSeenAt)
      .map((workspace) => ({
        id: workspace.id,
        label: workspace.label,
        activeSessions: workspace.clients.size,
        lastSeenAt: workspace.lastSeenAt,
      }));
    const selectedDefault = this.defaultWorkspaceId && this.workspaces.has(this.defaultWorkspaceId)
      ? this.defaultWorkspaceId
      : workspaces[0]?.id;
    return { workspaces, ...(selectedDefault ? { defaultWorkspaceId: selectedDefault } : {}) };
  }

  resolve(workspaceId?: string): EventStore | undefined {
    const id = workspaceId === undefined ? this.catalog().defaultWorkspaceId : workspaceId;
    return id === undefined ? undefined : this.workspaces.get(id)?.store;
  }

  sweepStale(): number {
    let total = 0;
    for (const workspace of this.workspaces.values()) total += workspace.store.sweepStale();
    return total;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const workspace of this.workspaces.values()) workspace.tailer.stop();
    this.clients.clear();
    this.workspaces.clear();
    this.defaultWorkspaceId = undefined;
    this.onClientCountChanged?.();
  }

  private createWorkspace(registration: WorkspaceRegistration): WorkspaceState {
    const store = new EventStore();
    const tailer = new TelemetryTailer({
      store,
      workspaceId: registration.workspaceId,
      cwd: registration.cwd,
      agentDir: this.agentDir,
    });
    const workspace: WorkspaceState = {
      id: registration.workspaceId,
      cwd: registration.cwd,
      label: workspaceLabel(registration.cwd),
      lastSeenAt: this.now(),
      clients: new Set(),
      store,
      tailer,
    };
    this.workspaces.set(workspace.id, workspace);
    tailer.start();
    return workspace;
  }

  private makeRoom(): void {
    if (this.workspaces.size < this.maxWorkspaces) return;
    const inactive = [...this.workspaces.values()]
      .filter((workspace) => workspace.clients.size === 0)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (!inactive) throw new WorkspaceRegistryError(503, "maximum active workspace limit reached");
    inactive.tailer.stop();
    this.workspaces.delete(inactive.id);
    if (this.defaultWorkspaceId === inactive.id) this.defaultWorkspaceId = undefined;
  }

  private touch(lease: ClientLease, workspace: WorkspaceState, selectAsDefault = true): void {
    const now = this.now();
    lease.expiresAt = now + this.leaseMs;
    workspace.lastSeenAt = now;
    if (selectAsDefault) this.defaultWorkspaceId = workspace.id;
  }

  private removeClient(clientId: string, seenNow: boolean): boolean {
    const lease = this.clients.get(clientId);
    if (!lease) return false;
    this.clients.delete(clientId);
    const workspace = this.workspaces.get(lease.registration.workspaceId);
    if (workspace) {
      workspace.clients.delete(clientId);
      if (seenNow) workspace.lastSeenAt = this.now();
    }
    this.onClientCountChanged?.();
    return true;
  }
}

function validateRegistration(value: unknown): WorkspaceRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceRegistryError(400, "registration must be an object");
  const input = value as Record<string, unknown>;
  if (!safeToken(input.clientId, 128) || !safeToken(input.sessionId, 256)) throw new WorkspaceRegistryError(400, "clientId and sessionId must be bounded non-empty strings");
  if (!Number.isSafeInteger(input.pid) || (input.pid as number) < 1) throw new WorkspaceRegistryError(400, "pid must be a positive integer");
  if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 4_096 || !path.isAbsolute(input.cwd)) {
    throw new WorkspaceRegistryError(400, "cwd must be an absolute path");
  }
  const cwd = path.resolve(input.cwd);
  const workspaceId = workspaceHash(cwd);
  if (input.workspaceId !== workspaceId) throw new WorkspaceRegistryError(400, "workspaceId does not match cwd");
  if (!safeText(input.label, 256)) throw new WorkspaceRegistryError(400, "label must be a bounded string");
  return {
    clientId: input.clientId,
    sessionId: input.sessionId,
    pid: input.pid as number,
    workspaceId,
    cwd,
    // Derive this at the trust boundary. A private caller cannot make a path or credential the UI label.
    label: workspaceLabel(cwd),
  };
}

function workspaceLabel(cwd: string): string {
  const base = path.basename(cwd).normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f<>]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(base).slice(0, 80).join("") || "workspace";
}

function safeToken(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f<>]/.test(value);
}

function sameRegistration(a: WorkspaceRegistration, b: WorkspaceRegistration): boolean {
  return a.clientId === b.clientId && a.sessionId === b.sessionId && a.pid === b.pid && a.workspaceId === b.workspaceId && sameWorkspacePath(a.cwd, b.cwd);
}

function sameWorkspacePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseEvent(value: unknown): TelemetryEvent | undefined {
  return parseTelemetryEvent(value);
}
