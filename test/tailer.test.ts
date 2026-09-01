import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, appendFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStore } from "../src/event-store.ts";
import { entityKey } from "../src/reducer.ts";
import { MAX_PARTIAL_LINE_BYTES, MAX_READ_BYTES, TelemetryTailer, workspaceHash } from "../src/tailer.ts";
import { TELEMETRY_VERSION, type TelemetryEvent } from "../shared/protocol.ts";

function event(workspaceId: string, seq = 1): TelemetryEvent {
  return {
    version: TELEMETRY_VERSION,
    producerId: "pi-persona",
    producerVersion: "1.10.5",
    id: `s:${seq}`,
    seq,
    ts: seq,
    sessionId: "s",
    workspaceId,
    type: "instance.heartbeat",
    payload: { contextPercent: seq },
  };
}

function fixture() {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-tailer-"));
  const cwd = join(agentDir, "workspace");
  const workspaceId = workspaceHash(cwd);
  const dir = join(agentDir, "pi-persona", "flow", workspaceId);
  mkdirSync(dir, { recursive: true });
  return { agentDir, cwd, workspaceId, dir };
}

test("TelemetryTailer retains a partial JSONL line until its newline arrives", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const line = JSON.stringify(event(f.workspaceId));
  const file = join(f.dir, "s.jsonl");
  writeFileSync(file, line.slice(0, -3));
  tailer.start();
  assert.equal(store.cursor, 0);
  appendFileSync(file, `${line.slice(-3)}\n`);
  tailer.scanNow();
  assert.equal(store.cursor, 1);
  assert.equal(store.snapshot().state.events[0]!.id, "s:1");
  tailer.stop();
});

interface TailerFileState { offset: number; partial: Buffer; discardingPartial: boolean }

function fileState(tailer: TelemetryTailer, file: string): TailerFileState {
  const state = (tailer as unknown as { files: Map<string, TailerFileState> }).files.get(file);
  assert.ok(state, `tailer has no state for ${file}`);
  return state;
}

/** Scan until the whole file is consumed; a per-tick work budget needs many passes. */
function drain(tailer: TelemetryTailer, file: string, limit = 500): void {
  for (let i = 0; i < limit; i += 1) {
    const state = (tailer as unknown as { files: Map<string, TailerFileState> }).files.get(file);
    if (state?.offset === statSync(file).size) return;
    tailer.scanNow();
  }
  assert.fail(`tailer did not converge on ${file} within ${limit} scans`);
}

test("TelemetryTailer bounds an unterminated line while waiting for a newline", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const file = join(f.dir, "s.jsonl");
  writeFileSync(file, "x".repeat(MAX_PARTIAL_LINE_BYTES + 128 * 1024));
  tailer.start();
  drain(tailer, file);
  const bounded = fileState(tailer, file);
  assert.equal(store.cursor, 0, "an unterminated blob is never ingested");
  assert.equal(bounded.discardingPartial, true, "the bound is reached, not merely approached");
  assert.equal(bounded.partial.length, 0, "the over-long partial is released, not retained");

  // The discarded run ends at the next newline; the line after it must still land.
  const line = JSON.stringify(event(f.workspaceId));
  appendFileSync(file, `\n${line}\n`);
  drain(tailer, file);
  assert.equal(store.cursor, 1);
  assert.equal(store.snapshot().state.events[0]!.id, "s:1");
  assert.equal(fileState(tailer, file).partial.length, 0);
  tailer.stop();
});

test("TelemetryTailer accepts immediate events and rejects another workspace", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, workspaceId: f.workspaceId, pollMs: 0 });
  assert.equal(tailer.ingest(event(f.workspaceId)), true);
  assert.equal(tailer.ingest(event("fedcba987654321001234567", 2)), false);
  assert.equal(store.cursor, 1);
});

test("TelemetryTailer dual-reads the neutral v2 producer namespace", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, workspaceId: f.workspaceId, pollMs: 0 });
  const dir = join(f.agentDir, "telemetry", "v2", f.workspaceId, "other.plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), `${JSON.stringify({ ...event(f.workspaceId), producerId: "other.plugin", producerVersion: "2.0.0", id: "other.plugin:s:1" })}\n`);
  tailer.start();
  assert.equal(store.cursor, 1);
  tailer.stop();
});

test("TelemetryTailer accepts a bounded large common-schema event", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, workspaceId: f.workspaceId, pollMs: 0 });
  const dir = join(f.agentDir, "telemetry", "v2", f.workspaceId, "other.plugin");
  mkdirSync(dir, { recursive: true });
  const peers = Array.from({ length: 180 }, (_, index) => ({
    sessionId: `peer-${index}`,
    displayName: `peer-${index}`,
    persona: "worker",
    model: `provider/${"m".repeat(500)}`,
    contextPercent: 0,
    status: "online",
    sent: 0,
    received: 0,
  }));
  const large = { ...event(f.workspaceId), producerId: "other.plugin", producerVersion: "2.0.0", id: "other.plugin:s:large", type: "peers.snapshot", payload: { peers } };
  const encoded = `${JSON.stringify(large)}\n`;
  assert.ok(Buffer.byteLength(encoded) > 64 * 1024, "fixture must cross the old line ceiling");
  writeFileSync(join(dir, "large.jsonl"), encoded);
  tailer.start();
  for (let i = 0; i < 8 && store.cursor === 0; i += 1) tailer.scanNow();
  assert.equal(store.cursor, 1);
  assert.equal(Object.keys(store.snapshot().state.peers).length, peers.length);
  tailer.stop();
});

/** One session log of `count` events; each file needs its own session to clear sequence dedupe. */
function logLines(workspaceId: string, sessionId: string, count: number): string {
  let text = "";
  for (let seq = 1; seq <= count; seq += 1) {
    text += `${JSON.stringify({ ...event(workspaceId, seq), sessionId, id: `${sessionId}:${seq}`, payload: { contextPercent: seq % 101 } })}\n`;
  }
  return text;
}

function consumedBytes(tailer: TelemetryTailer): number {
  const files = (tailer as unknown as { files: Map<string, TailerFileState> }).files;
  let total = 0;
  for (const state of files.values()) total += state.offset;
  return total;
}

test("TelemetryTailer spreads one scan across ticks instead of draining every log at once", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const logs = 16;
  const perLog = 200;
  let onDisk = 0;
  for (let index = 0; index < logs; index += 1) {
    const text = logLines(f.workspaceId, `session-${index}`, perLog);
    onDisk += Buffer.byteLength(text);
    writeFileSync(join(f.dir, `session-${index}.jsonl`), text);
  }
  assert.ok(onDisk > 512 * 1024, `fixture must exceed one tick of work (${onDisk} bytes)`);

  tailer.scanNow();
  assert.ok(consumedBytes(tailer) <= 512 * 1024, `one tick read ${consumedBytes(tailer)} bytes of history`);
  assert.ok(store.cursor < logs * perLog, `one tick ingested every log (${store.cursor}/${logs * perLog})`);

  // Every log still lands: a deferred file must be resumed, never starved.
  for (let i = 0; i < 400 && store.cursor < logs * perLog; i += 1) tailer.scanNow();
  assert.equal(store.cursor, logs * perLog);
  tailer.stop();
});

test("TelemetryTailer leaves logs older than the retention window unread", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const cold = join(f.dir, "cold.jsonl");
  writeFileSync(cold, logLines(f.workspaceId, "cold", 3));
  const aged = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(cold, aged, aged);

  tailer.start();
  for (let i = 0; i < 8; i += 1) tailer.scanNow();
  assert.equal(store.cursor, 0, "history outside the window is not replayed");
  assert.equal(statSync(cold).size > 0, true, "the stale log is skipped, never deleted");

  writeFileSync(join(f.dir, "hot.jsonl"), logLines(f.workspaceId, "hot", 3));
  tailer.scanNow();
  assert.equal(store.cursor, 3);
  tailer.stop();
});

/** One appended line for the live session; the freshest log is the dashboard's headline feature. */
function liveLine(workspaceId: string, seq: number): string {
  return `${JSON.stringify({ ...event(workspaceId, seq), sessionId: "live", id: `live:${seq}`, payload: { contextPercent: seq % 101 } })}\n`;
}

test("TelemetryTailer services the freshest log before cold history", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const logs = 12;
  const perLog = 400;
  const aged = new Date(Date.now() - 60 * 60 * 1000);
  for (let index = 0; index < logs; index += 1) {
    const file = join(f.dir, `cold-${index}.jsonl`);
    const text = logLines(f.workspaceId, `cold-${index}`, perLog);
    assert.ok(Buffer.byteLength(text) > 64 * 1024, `each cold log must outlast one read (${Buffer.byteLength(text)} bytes)`);
    writeFileSync(file, text);
    utimesSync(file, aged, aged);
  }
  const live = join(f.dir, "live.jsonl");
  appendFileSync(live, liveLine(f.workspaceId, 1));

  tailer.scanNow();
  const sessions = new Set(store.snapshot().state.events.map((entry) => entry.sessionId));
  assert.equal(sessions.has("live"), true, "the newest log is serviced first");
  assert.ok(store.cursor < logs * perLog + 1, `cold history was not deferred (${store.cursor} events)`);

  // Steady state matters more than the first tick: a resumed cold rotation must never
  // delay the live stream, so every tick has to land the line appended just before it.
  for (let seq = 2; seq <= 20; seq += 1) {
    appendFileSync(live, liveLine(f.workspaceId, seq));
    tailer.scanNow();
    assert.equal(store.snapshot().state.lastSeq["pi-persona::live"], seq, `tick ${seq} left the live log behind cold history`);
  }

  // Cold history still drains; the unconditional live slot must not stall the rotation.
  for (let i = 0; i < 400 && store.cursor < logs * perLog + 20; i += 1) tailer.scanNow();
  assert.equal(store.cursor, logs * perLog + 20, "deferred cold history never finished");
  tailer.stop();
});

test("TelemetryTailer refuses a retention window that is not a positive duration", () => {
  const f = fixture();
  const store = new EventStore();
  for (const retentionMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0, retentionMs }),
      RangeError,
      `retentionMs ${retentionMs} was accepted instead of refused`,
    );
  }
});

/** Compaction replaces the log by rename (pi-persona/src/telemetry/producer.ts), so the file the
 *  tailer is following gets a new identity while the same stream keeps flowing into it. */
function compact(file: string, lines: readonly string[], generation: number): void {
  const temp = `${file}.trim-${generation}`;
  writeFileSync(temp, lines.join(""));
  renameSync(temp, file);
}

/** Drive ticks until the stream reaches `target`, returning how many it took. A restart re-reads a
 *  compacted log one slice per tick, so catching up is a bounded number of ticks — never zero, and
 *  never unbounded: a livelock shows up here as exhausting `maxTicks`. */
function drainUntil(tailer: TelemetryTailer, store: EventStore, key: string, target: number, maxTicks: number): number {
  for (let tick = 1; tick <= maxTicks; tick += 1) {
    tailer.scanNow();
    if (store.snapshot().state.lastSeq[key] === target) return tick;
  }
  return Number.POSITIVE_INFINITY;
}

test("TelemetryTailer catches up on a log replaced by rename, without livelocking", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const file = join(f.dir, "live.jsonl");
  // A compacted log is several read slices long, so a restart has to walk it across ticks.
  const lines: string[] = [];
  let seq = 0;
  let bytes = 0;
  while (bytes <= 3 * 64 * 1024) {
    seq += 1;
    const line = liveLine(f.workspaceId, seq);
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  writeFileSync(file, lines.join(""));
  tailer.start();

  // Each compaction sheds the head and appends at the tail — the shape the producer actually writes.
  for (let generation = 1; generation <= 5; generation += 1) {
    seq += 1;
    lines.shift();
    lines.push(liveLine(f.workspaceId, seq));
    compact(file, lines, generation);
    const ticks = drainUntil(tailer, store, "pi-persona::live", seq, 32);
    assert.ok(
      Number.isFinite(ticks),
      `compaction ${generation} stranded the tailer: 32 ticks never reached seq ${seq}`,
    );
  }
  tailer.stop();
});

test("TelemetryTailer takes one slice, not the whole file, the first time it sees a cold log", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const file = join(f.dir, "cold.jsonl");
  const text = logLines(f.workspaceId, "cold", 12_000);
  assert.ok(Buffer.byteLength(text) > 2 * 1024 * 1024, `fixture must dwarf one slice (${Buffer.byteLength(text)} bytes)`);
  writeFileSync(file, text);

  // A megabytes-wide log arrives on the same event loop as everything else: the tick that first sees
  // it may read one slice of it and no more, whatever it costs to catch up afterwards.
  tailer.scanNow();
  assert.equal(fileState(tailer, file).offset, MAX_READ_BYTES, "one tick swallowed more than a single slice of cold history");
  tailer.stop();
});

/** A log wide enough that no single tick may read it whole, newest record last. */
/** An agent.added record: the shape a producer parks at a compacted log's head as a replay seed. */
function agentAddedLine(workspaceId: string, seq: number, id: string): string {
  return `${JSON.stringify({
    ...event(workspaceId, seq), sessionId: "live", id: `live:${seq}`, type: "agent.added",
    payload: { id, label: id, kind: "subagent", status: "running" },
  })}
`;
}

function wideLog(workspaceId: string, bytesWanted: number, startSeq = 0): string[] {
  const lines: string[] = [];
  let bytes = 0;
  while (bytes <= bytesWanted) {
    const line = liveLine(workspaceId, startSeq + lines.length + 1);
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  return lines;
}

test("a compacted log's replay seeds are read, so the agent roster survives the restart", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const file = join(f.dir, "live.jsonl");
  // Compaction parks the seeds that rebuild live state at the HEAD. Skipping ahead to the tail — which
  // is cheaper and looks harmless, because the newest records are all there — costs the whole agent
  // roster: the reducer drops an agent.updated whose agent.added it never saw, and every later
  // compaction re-parks the same seeds where a caught-up tailer would skip them again.
  const roster = Array.from({ length: 10 }, (_, index) => `a-${index}`);
  let seq = 0;
  const seeds = roster.map((id) => agentAddedLine(f.workspaceId, (seq += 1), id));
  const history = wideLog(f.workspaceId, 2 * 64 * 1024, seq);
  seq += history.length;
  writeFileSync(file, [...seeds, ...history].join(""));

  // The dashboard attaches mid-session: one slice in, the producer compacts underneath it.
  tailer.scanNow();
  const compacted = [...seeds, ...history.slice(history.length - 200)];
  seq += 1;
  compacted.push(liveLine(f.workspaceId, seq));
  compact(file, compacted, 1);

  const ticks = drainUntil(tailer, store, "pi-persona::live", seq, 32);
  assert.ok(Number.isFinite(ticks), `the tailer never caught up after compaction (32 ticks, target seq ${seq})`);
  const agents = store.snapshot().state.agents;
  const missing = roster.filter((id) => agents[entityKey("pi-persona", "live", id)] === undefined);
  assert.deepEqual(missing, [], `the restart skipped the head, losing ${missing.length} of ${roster.length} agents`);
  tailer.stop();
});

/** One peers.snapshot wider than a slice; the bounded roster is the producer's largest record. */
function widePeersLine(workspaceId: string, seq: number): string {
  const peers = Array.from({ length: 180 }, (_, index) => ({
    sessionId: `peer-${index}`,
    displayName: `peer-${index}`,
    persona: "worker",
    model: `provider/${"m".repeat(500)}`,
    contextPercent: 0,
    status: "online",
    sent: 0,
    received: 0,
  }));
  return `${JSON.stringify({ ...event(workspaceId, seq), sessionId: "live", id: `live:${seq}`, type: "peers.snapshot", payload: { peers } })}
`;
}

test("TelemetryTailer keeps reading when a resync lands inside an oversized record", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const file = join(f.dir, "live.jsonl");
  const lines = wideLog(f.workspaceId, 128 * 1024);
  const wide = widePeersLine(f.workspaceId, lines.length + 1);
  assert.ok(Buffer.byteLength(wide) > MAX_READ_BYTES, `the tail record must outgrow one slice (${Buffer.byteLength(wide)} bytes)`);
  lines.push(wide);
  writeFileSync(file, lines.join(""));

  tailer.scanNow();
  compact(file, lines, 1);
  const seq = lines.length + 1;
  appendFileSync(file, liveLine(f.workspaceId, seq));
  const ticks = drainUntil(tailer, store, "pi-persona::live", seq, 64);
  assert.ok(Number.isFinite(ticks), `a record wider than one slice swallowed the records after it (64 ticks, target seq ${seq})`);
  tailer.stop();
});

/** The producer compacts as writeFile(temp) -> rename(file, backup) -> rename(temp, file) -> unlink,
 *  so the followed path is absent between the two renames; a poll can land there. */
test("TelemetryTailer keeps following a log across a scan that lands mid-rename", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const file = join(f.dir, "live.jsonl");
  const lines = wideLog(f.workspaceId, 3 * 64 * 1024);
  let seq = lines.length;
  writeFileSync(file, lines.join(""));
  tailer.start();

  for (let generation = 1; generation <= 5; generation += 1) {
    seq += 1;
    lines.shift();
    lines.push(liveLine(f.workspaceId, seq));
    const temp = `${file}.trim-${generation}`;
    const backup = `${file}.previous`;
    writeFileSync(temp, lines.join(""));
    renameSync(file, backup);
    tailer.scanNow();
    renameSync(temp, file);
    unlinkSync(backup);
    const ticks = drainUntil(tailer, store, "pi-persona::live", seq, 32);
    assert.ok(
      Number.isFinite(ticks),
      `a scan inside compaction ${generation}'s rename window stranded the tailer (32 ticks, target seq ${seq})`,
    );
  }
  tailer.stop();
});

test("TelemetryTailer reads a replacement narrower than one slice from its first record", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const file = join(f.dir, "live.jsonl");
  writeFileSync(file, wideLog(f.workspaceId, 128 * 1024).join(""));
  tailer.scanNow();

  // Compaction can shed a log down to a handful of records. A resync window that opens at the head
  // opens on a record boundary, so nothing may be discarded ahead of it.
  const seq = 100_000;
  compact(file, [liveLine(f.workspaceId, seq)], 1);
  tailer.scanNow();
  assert.equal(store.snapshot().state.lastSeq["pi-persona::live"], seq, "the whole replacement was mistaken for a mid-record fragment");
  tailer.stop();
});

test("TelemetryTailer forgets a log that stays gone", () => {
  const f = fixture();
  const store = new EventStore();
  const tailer = new TelemetryTailer({ store, agentDir: f.agentDir, cwd: f.cwd, workspaceId: f.workspaceId, pollMs: 0 });
  const file = join(f.dir, "live.jsonl");
  writeFileSync(file, liveLine(f.workspaceId, 1));
  tailer.scanNow();
  const files = (tailer as unknown as { files: Map<string, TailerFileState> }).files;
  assert.equal(files.has(file), true);

  // The scan of grace that covers a rename window is one scan, not a licence to keep state forever.
  unlinkSync(file);
  tailer.scanNow();
  tailer.scanNow();
  assert.equal(files.has(file), false, "a deleted log kept its state past the grace scan");
  tailer.stop();
});
