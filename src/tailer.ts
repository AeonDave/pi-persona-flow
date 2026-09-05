import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { parseTelemetryEvent } from "../shared/protocol.ts";
import { EventStore } from "./event-store.ts";

export function workspaceHash(cwd: string): string {
  const resolved = path.resolve(cwd);
  const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

/** Common-schema snapshots can contain a bounded peer roster; keep one complete event bounded. */
export const MAX_PARTIAL_LINE_BYTES = 1024 * 1024;
/** The most any single log gives up in one tick, so a cold or replaced log cannot own the loop. */
export const MAX_READ_BYTES = 64 * 1024;
/**
 * One tick runs inside the host agent's event loop, so the bytes a scan reads are bounded per tick and
 * it resumes later. Both limits are checked BETWEEN files, and a resumed tick reads two files before the
 * first check — the freshest log's reserved slot and the rotation's resume entry — so the worst tick is
 * those two reads plus this allowance. Discovery and the per-file stat are not budgeted; they scale with
 * the number of logs on disk. The cost is bounded, not zero.
 */
const SCAN_BUDGET_BYTES = 256 * 1024;
const SCAN_BUDGET_MS = 5;
/** Nothing here deletes a user's log; history quieter than this window is simply not replayed. */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface TelemetryTailerOptions {
  store: EventStore;
  workspaceId: string;
  cwd?: string;
  agentDir?: string;
  pollMs?: number;
  /** How far back a log's mtime may be before the scan leaves it unread; defaults to 24h. */
  retentionMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * What one tick needs to know about a log, with the identity taken from a BIGINT stat.
 *
 * `fs.Stats.ino` is a JS double, and an NTFS file reference is a 64-bit value that does not survive
 * one: measured on this machine, ~5-35% of fresh files report an `ino` that differs from the exact
 * value, and distinct files collide outright on the truncated number. Identity is what tells a
 * compaction rename apart from an append, so a collision there makes the tailer keep its old offset
 * and resume mid-file in the replacement — skipping the head, which is exactly where the producer
 * parks its replay seeds. `birthtimeMs` is not a substitute: NTFS tunnelling carries a creation time
 * across a rename onto the same name.
 */
export interface LogStat {
  size: number;
  mtimeMs: number;
  identity: string;
}

/** Exported so the identity rule can be measured directly against real files on the host filesystem. */
export function logStat(file: string): LogStat {
  const stat = fs.statSync(file, { bigint: true });
  return { size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), identity: `${stat.dev}:${stat.ino}` };
}

interface FileState {
  offset: number;
  partial: Buffer;
  identity?: string;
  discardingPartial: boolean;
  /** Set by a scan that did not find this path, so a rename window costs one scan and not the state. */
  missing: boolean;
}

/** Tails every producer log for one workspace and feeds the shared EventStore. */
export class TelemetryTailer {
  readonly directory: string;
  private readonly directories: string[];
  private readonly store: EventStore;
  private readonly workspaceId: string;
  private readonly pollMs: number;
  private readonly retentionMs: number;
  private readonly onError?: (error: unknown) => void;
  private readonly files = new Map<string, FileState>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Where the previous tick ran out of budget, so the next one resumes there. */
  private resumeFrom: string | undefined;

  constructor(options: TelemetryTailerOptions);
  constructor(store: EventStore, workspaceId: string, options?: Omit<TelemetryTailerOptions, "store" | "workspaceId">);
  constructor(
    optionsOrStore: TelemetryTailerOptions | EventStore,
    positionalWorkspaceId?: string,
    positionalOptions: Omit<TelemetryTailerOptions, "store" | "workspaceId"> = {},
  ) {
    const options: TelemetryTailerOptions = optionsOrStore instanceof EventStore
      ? { ...positionalOptions, store: optionsOrStore, workspaceId: positionalWorkspaceId! }
      : optionsOrStore;
    this.store = options.store;
    this.workspaceId = options.workspaceId;
    this.pollMs = options.pollMs ?? 250;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    if (!Number.isFinite(this.retentionMs) || this.retentionMs < 1) throw new RangeError("retentionMs must be positive");
    this.onError = options.onError;
    const agentDir = options.agentDir ?? getAgentDir();
    const cwdHash = options.cwd ? workspaceHash(options.cwd) : options.workspaceId;
    if (cwdHash !== options.workspaceId) throw new Error("workspaceId does not match cwd");
    this.directory = path.join(agentDir, "pi-persona", "flow", options.workspaceId);
    // v1 sat inside the producer's own storage root, which was renamed `pi-persona` -> `persona`. No
    // producer writes v1 any more, so both entries are pure legacy compatibility — but a migration moves
    // a user's existing logs to the new root and dropping either name silently loses history the
    // dashboard used to show. An absent root costs one ENOENT readdir a tick, so read both.
    this.directories = [
      path.join(agentDir, "telemetry", "v2", options.workspaceId),
      path.join(agentDir, "persona", "flow", options.workspaceId),
      this.directory,
    ];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scan();
    if (this.pollMs > 0) {
      this.timer = setInterval(() => this.scan(), this.pollMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Synchronously scan once; useful for deterministic callers and tests. */
  scanNow(): void {
    this.scan();
  }

  poll(): void {
    this.scanNow();
  }

  /** Ingest the same envelope delivered by pi.events immediately. */
  ingest(value: unknown): boolean {
    const event = parseTelemetryEvent(value);
    if (!event || event.workspaceId !== this.workspaceId) return false;
    return this.store.append(event) !== undefined;
  }

  private scan(): void {
    if (!this.running && this.timer) return;
    const files: string[] = [];
    for (const directory of this.directories) {
      try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(directory, entry.name));
          if (!entry.isDirectory()) continue;
          const producerDir = path.join(directory, entry.name);
          try {
            for (const child of fs.readdirSync(producerDir, { withFileTypes: true })) {
              if (child.isFile() && child.name.endsWith(".jsonl")) files.push(path.join(producerDir, child.name));
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError?.(error);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError?.(error);
      }
    }

    const present = new Set(files);
    // A followed path vanishes for an instant while a producer compacts: pi-persona renames the log to
    // a backup before renaming its replacement into place. Forgetting the state inside that window makes
    // the next scan a first sighting that starts over at offset 0, so the tailer drops a compaction
    // behind every time a poll lands there. One scan of grace covers the window; a log that is really
    // gone is forgotten on the scan after it.
    for (const [file, state] of this.files) {
      if (present.has(file)) state.missing = false;
      else if (state.missing) this.files.delete(file);
      else state.missing = true;
    }

    // Freshest first: a live stream must never queue behind cold session history.
    const oldest = Date.now() - this.retentionMs;
    const ordered: Array<{ file: string; stat: LogStat }> = [];
    for (const file of files) {
      const stat = this.statFile(file);
      if (stat && stat.mtimeMs >= oldest) ordered.push({ file, stat });
    }
    if (ordered.length === 0) return;
    ordered.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

    const resumeIndex = this.resumeFrom === undefined ? -1 : ordered.findIndex((entry) => entry.file === this.resumeFrom);
    const first = resumeIndex >= 0 ? resumeIndex : 0;
    this.resumeFrom = undefined;
    const deadline = performance.now() + SCAN_BUDGET_MS;
    let budget = SCAN_BUDGET_BYTES;
    // The freshest log gets an unconditional slot every tick: a resumed rotation only reaches index 0
    // once it has walked the whole backlog, which would leave the live stream many ticks behind.
    const resumed = first !== 0;
    if (resumed) budget -= this.readFile(ordered[0]!.file, ordered[0]!.stat);
    for (let step = 0; step < ordered.length; step += 1) {
      const index = (first + step) % ordered.length;
      if (resumed && index === 0) continue;
      const entry = ordered[index]!;
      // One cold file always makes progress; the rotation then guarantees no file starves.
      if (step > 0 && (budget <= 0 || performance.now() >= deadline)) {
        this.resumeFrom = entry.file;
        return;
      }
      budget -= this.readFile(entry.file, entry.stat);
    }
  }

  private statFile(file: string): LogStat | undefined {
    try {
      return logStat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError?.(error);
      return undefined;
    }
  }

  /** Consume the next slice of one log and report how many bytes that spent. */
  private readFile(file: string, stat: LogStat): number {
    const identity = stat.identity;
    let state = this.files.get(file);
    if (!state) {
      state = { offset: 0, partial: Buffer.alloc(0), identity, discardingPartial: false, missing: false };
      this.files.set(file, state);
    } else if (state.identity !== identity || stat.size < state.offset) {
      // A log this tailer was already following came back as different content: it was replaced by
      // rename or truncated in place, so the offset consumed so far no longer describes it. Re-read it
      // from the START, one slice per tick like any other log.
      //
      // The head is not skippable. Compaction parks the producer's replay seeds there — the minimum
      // records needed to rebuild live state — and the reducer drops an `agent.updated` whose agent it
      // never saw, so a tailer that jumps to the tail loses the agent roster for the rest of the
      // session and never recovers it. Two cheaper-looking options were measured and rejected: jumping
      // to the last slice strands that roster, and reading the whole replacement inside one tick spends
      // ~600 ms of the host's event loop on a 4 MiB log.
      //
      // The cost is catch-up latency, not lost data: re-reading a compacted log at 64 KiB/tick takes
      // ~8 s for the producer's ~2 MiB retained size, and the re-read records cost bytes only — the
      // store drops them on the per-(producerId, sessionId) sequence check. A log replaced FASTER than
      // one slice per tick would never finish, but the shipped producer compacts roughly every 2 MiB of
      // events, not every tick.
      state.identity = identity;
      state.offset = 0;
      state.partial = Buffer.alloc(0);
      state.discardingPartial = false;
    }
    if (stat.size <= state.offset) return 0;

    // One slice per tick, resumed next poll, stopping at the byte range this stat confirmed so a
    // concurrent append is picked up next poll instead of read half-written.
    const toRead = Math.min(stat.size - state.offset, MAX_READ_BYTES);
    let consumed = 0;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const bytes = Buffer.allocUnsafe(toRead);
      consumed = fs.readSync(fd, bytes, 0, toRead, state.offset);
      if (consumed > 0) {
        state.offset += consumed;
        this.consumeBytes(state, bytes.subarray(0, consumed));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError?.(error);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return consumed;
  }

  /** Split one freshly read chunk into complete lines and ingest them; the tail is carried forward. */
  private consumeBytes(state: FileState, appended: Buffer): void {
    const input = state.partial.length === 0 ? appended : Buffer.concat([state.partial, appended]);
    let start = 0;
    for (let end = input.indexOf(0x0a); end >= 0; end = input.indexOf(0x0a, start)) {
      const lineBytes = input.subarray(start, end);
      start = end + 1;
      if (state.discardingPartial) {
        state.discardingPartial = false;
        continue;
      }
      if (lineBytes.length > MAX_PARTIAL_LINE_BYTES) continue;
      const line = lineBytes.toString("utf8").replace(/\r$/, "");
      if (!line.trim()) continue;
      try {
        this.ingest(JSON.parse(line));
      } catch (error) {
        // Malformed complete lines are discarded; a later line must remain readable.
        if (error instanceof SyntaxError) continue;
        this.onError?.(error);
      }
    }
    const remaining = input.subarray(start);
    if (state.discardingPartial) {
      state.partial = Buffer.alloc(0);
    } else if (remaining.length > MAX_PARTIAL_LINE_BYTES) {
      state.partial = Buffer.alloc(0);
      state.discardingPartial = true;
    } else {
      state.partial = Buffer.from(remaining);
    }
  }
}
