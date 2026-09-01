/**
 * Wire-spec conformance corpus — consumer side.
 *
 * shared/protocol.ts (this repo) and src/telemetry/contract.ts (pi-persona) are hand-mirrored
 * implementations of one wire spec, and the duplication is deliberate: a consumer that imported the
 * producer's parser could not validate against a buggy or hostile producer, and a vendor-neutral
 * contract cannot force every future producer to depend on pi-persona. So the corpus is what keeps
 * the two honest. The block between the two banner comments below is byte-identical to
 * pi-persona/test/unit/telemetry/parity.test.ts — keep it diffable, and change both files or neither.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isKnownTelemetryEvent, parseTelemetryEvent, sanitizeTelemetryPayload, type TelemetryEvent } from "../shared/protocol.ts";

// --- shared conformance corpus: byte-identical in both repos, change both or neither -------------

/** One wire case. `accept` present = both parsers must accept and project exactly that payload;
 *  absent = both must reject. `envelope` names the fields a parser rewrites (legacy dual-read). */
interface WireCase {
  name: string;
  input: unknown;
  accept?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
}

const BASE = {
  version: 2,
  producerId: "pi-persona",
  producerVersion: "1.0.0",
  id: "pi-persona:session-1:1",
  seq: 1,
  ts: 1_700_000_000_000,
  sessionId: "session-1",
  workspaceId: "0123456789abcdef01234567",
  type: "agent.cleared",
  payload: {},
};

/** A valid v2 envelope with `over` applied; the defaults are themselves an accepted case. */
function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE, ...over };
}
function wireWithout(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const out = wire(over);
  delete out[key];
  return out;
}

/** Read a `new Set([...])` literal out of a source file. The known-type set is duplicated across
 *  files that deliberately cannot import each other, so the guard has to compare the text. */
function setLiteral(file: string, declaration: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} no longer exists in ${file}`);
  const body = /\[([\s\S]*?)\]/.exec(source.slice(start));
  assert.ok(body, `${declaration} in ${file} is no longer a Set literal`);
  return [...body[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!).sort();
}

const KNOWN_TYPES = [
  "instance.started", "instance.updated", "instance.heartbeat", "instance.stopped",
  "agent.added", "agent.updated", "agent.removed", "agent.cleared",
  "tool.started", "tool.finished", "message.sent", "message.received", "message.replied", "peers.snapshot",
];

const PEER = { sessionId: "s-2", displayName: "vega", persona: "dev", model: "provider/model", contextPercent: 40, status: "online", color: "#89b4fa", sent: 3, received: 4 };
const MESSAGE = { id: "m-1", channel: "exocom", from: "orion", to: "vega", kind: "question", status: "queued", expectsReply: true, size: 128 };

const CORPUS: WireCase[] = [
  // --- accepted envelopes ------------------------------------------------------------------------
  { name: "instance.started with full pi-persona metadata", input: wire({ type: "instance.started", payload: { displayName: "orion", status: "active", persona: "dev", model: "provider/model", pid: 42, contextPercent: 12.5, exocomEnabled: true, color: "#89b4fa" } }), accept: { displayName: "orion", status: "active", persona: "dev", model: "provider/model", pid: 42, contextPercent: 12.5, exocomEnabled: true, color: "#89b4fa" } },
  { name: "instance.started from a producer with no persona, model or process metrics", input: wire({ producerId: "future.plugin", producerVersion: "2.3.0", type: "instance.started", payload: { displayName: "future worker", status: "active" } }), accept: { displayName: "future worker", status: "active" } },
  { name: "instance.heartbeat drops fields outside the common lifecycle", input: wire({ type: "instance.heartbeat", payload: { contextPercent: 50, producerPrivate: "discard me" } }), accept: { contextPercent: 50 } },
  { name: "instance.heartbeat accepts the empty partial", input: wire({ type: "instance.heartbeat", payload: {} }), accept: {} },
  { name: "instance.updated accepts contextPercent 0", input: wire({ type: "instance.updated", payload: { contextPercent: 0 } }), accept: { contextPercent: 0 } },
  { name: "instance.updated accepts contextPercent 100", input: wire({ type: "instance.updated", payload: { contextPercent: 100 } }), accept: { contextPercent: 100 } },
  { name: "instance.updated accepts pid 0", input: wire({ type: "instance.updated", payload: { pid: 0 } }), accept: { pid: 0 } },
  { name: "instance.stopped keeps only its reason", input: wire({ type: "instance.stopped", payload: { reason: "exit", detail: "SECRET-CANARY" } }), accept: { reason: "exit" } },
  { name: "agent.added strips task, detail, command and credential canaries", input: wire({ type: "agent.added", payload: { id: "run-1", label: "orion-recon", kind: "subagent", status: "running", parentId: "root", agent: "recon", persona: "dev", model: "provider/model", task: "SECRET-CANARY", detail: "SECRET-CANARY", command: "SECRET-CANARY", cwd: "SECRET-CANARY", apiKey: "SECRET-CANARY" } }), accept: { id: "run-1", label: "orion-recon", kind: "subagent", status: "running", parentId: "root", agent: "recon", persona: "dev", model: "provider/model" } },
  { name: "agent.updated narrows the patch and drops a spoofed id", input: wire({ type: "agent.updated", payload: { id: "run-1", patch: { status: "done", label: "renamed", id: "spoofed", token: "SECRET-CANARY" } } }), accept: { id: "run-1", patch: { label: "renamed", status: "done" } } },
  { name: "agent.removed accepts a terminal status", input: wire({ type: "agent.removed", payload: { id: "run-1", status: "stopped" } }), accept: { id: "run-1", status: "stopped" } },
  { name: "agent.cleared projects away everything", input: wire({ type: "agent.cleared", payload: { leftover: "SECRET-CANARY" } }), accept: {} },
  { name: "tool.started keeps the call identity, never the arguments", input: wire({ type: "tool.started", payload: { callId: "tc-1", agentId: "run-1", name: "Bash", status: "running", args: "SECRET-CANARY", durationMs: 5 } }), accept: { callId: "tc-1", agentId: "run-1", name: "Bash", status: "running" } },
  { name: "tool.finished keeps a zero duration", input: wire({ type: "tool.finished", payload: { callId: "tc-1", agentId: "run-1", name: "Bash", status: "done", durationMs: 0 } }), accept: { callId: "tc-1", agentId: "run-1", name: "Bash", status: "done", durationMs: 0 } },
  { name: "message.sent carries counts, never the body", input: wire({ type: "message.sent", payload: { ...MESSAGE, replyTo: "m-0", content: "SECRET-CANARY", prompt: "SECRET-CANARY" } }), accept: { ...MESSAGE, replyTo: "m-0" } },
  { name: "message.received without a reply linkage", input: wire({ type: "message.received", payload: { ...MESSAGE } }), accept: { ...MESSAGE } },
  { name: "message.replied projects the reply linkage", input: wire({ type: "message.replied", payload: { ...MESSAGE, status: "replied", replyTo: "m-0" } }), accept: { ...MESSAGE, status: "replied", replyTo: "m-0" } },
  { name: "peers.snapshot projects the roster", input: wire({ type: "peers.snapshot", payload: { peers: [PEER] } }), accept: { peers: [PEER] } },
  // Nested payloads are sanitised, not allowlisted: an unknown peer field survives on both sides.
  { name: "peers.snapshot keeps unknown peer fields but drops sensitive ones", input: wire({ type: "peers.snapshot", payload: { peers: [{ ...PEER, region: "eu", task: "SECRET-CANARY" }] } }), accept: { peers: [{ ...PEER, region: "eu" }] } },
  { name: "namespaced future-producer event keeps only its envelope", input: wire({ producerId: "other.plugin", producerVersion: "2.3.0", type: "other.plugin.status.changed", payload: { state: "ready", token: "SECRET-CANARY" } }), accept: {} },
  { name: "unknown type with a nested secret still projects to {}", input: wire({ producerId: "other.plugin", producerVersion: "2.3.0", type: "other.plugin/queue.drained", payload: { nested: { authorization: "SECRET-CANARY" }, depth: [1, 2, 3] } }), accept: {} },
  { name: "legacy v1 is dual-read and re-stamped as v2 pi-persona", input: { version: 1, id: "session-1:1", seq: 1, ts: 1_700_000_000_000, sessionId: "session-1", workspaceId: "0123456789abcdef01234567", type: "agent.added", payload: { id: "a", label: "agent", kind: "subagent", status: "running", task: "SECRET-CANARY", detail: "SECRET-CANARY" } }, accept: { id: "a", label: "agent", kind: "subagent", status: "running" }, envelope: { producerId: "pi-persona", producerVersion: "legacy-v1" } },
  { name: "legacy v1 ignores a producer identity claimed on the wire", input: { version: 1, producerId: "evil.plugin", producerVersion: "9.9.9", id: "session-1:2", seq: 2, ts: 1_700_000_000_001, sessionId: "session-1", workspaceId: "0123456789abcdef01234567", type: "instance.stopped", payload: { reason: "exit" } }, accept: { reason: "exit" }, envelope: { producerId: "pi-persona", producerVersion: "legacy-v1" } },

  // --- rejected envelopes ------------------------------------------------------------------------
  { name: "reject: unknown wire version", input: wire({ version: 3 }) },
  { name: "reject: version as a string", input: wire({ version: "2" }) },
  { name: "reject: missing version", input: wireWithout("version") },
  { name: "reject: legacy v1 carrying a namespaced type", input: { version: 1, id: "session-1:3", seq: 1, ts: 1, sessionId: "session-1", workspaceId: "0123456789abcdef01234567", type: "other.plugin.status.changed", payload: {} } },
  { name: "reject: empty id", input: wire({ id: "" }) },
  { name: "reject: id outside the safe charset", input: wire({ id: "pi persona:session:1" }) },
  { name: "reject: id with a fragment character", input: wire({ id: "pi-persona:session:1#frag" }) },
  { name: "reject: oversized id", input: wire({ id: "a".repeat(257) }) },
  { name: "reject: non-string id", input: wire({ id: 1 }) },
  { name: "reject: empty sessionId", input: wire({ sessionId: "" }) },
  { name: "reject: sessionId outside the safe charset", input: wire({ sessionId: "session 1" }) },
  { name: "reject: oversized sessionId", input: wire({ sessionId: "s".repeat(129) }) },
  { name: "reject: workspaceId in uppercase hex", input: wire({ workspaceId: "0123456789ABCDEF01234567" }) },
  { name: "reject: workspaceId too short", input: wire({ workspaceId: "0123456789abcdef0123456" }) },
  { name: "reject: workspaceId too long", input: wire({ workspaceId: "0123456789abcdef012345678" }) },
  { name: "reject: non-string workspaceId", input: wire({ workspaceId: 42 }) },
  { name: "reject: seq below 1", input: wire({ seq: 0 }) },
  { name: "reject: negative seq", input: wire({ seq: -1 }) },
  { name: "reject: fractional seq", input: wire({ seq: 1.5 }) },
  { name: "reject: seq beyond the safe integer range", input: wire({ seq: 2 ** 53 }) },
  { name: "reject: non-finite ts", input: wire({ ts: Number.NaN }) },
  { name: "reject: infinite ts", input: wire({ ts: Number.POSITIVE_INFINITY }) },
  { name: "reject: negative ts", input: wire({ ts: -1 }) },
  { name: "reject: non-number ts", input: wire({ ts: "1700000000000" }) },
  { name: "reject: null payload", input: wire({ payload: null }) },
  { name: "reject: array payload", input: wire({ payload: [] }) },
  { name: "reject: string payload", input: wire({ payload: "{}" }) },
  { name: "reject: missing payload", input: wireWithout("payload") },
  { name: "reject: v2 without a producerId", input: wireWithout("producerId") },
  { name: "reject: producerId outside the safe charset", input: wire({ producerId: "pi persona" }) },
  { name: "reject: oversized producerId", input: wire({ producerId: "p".repeat(97) }) },
  { name: "reject: v2 without a producerVersion", input: wireWithout("producerVersion") },
  { name: "reject: producerVersion outside the safe charset", input: wire({ producerVersion: "1.0 beta" }) },
  { name: "reject: oversized producerVersion", input: wire({ producerVersion: "9".repeat(65) }) },
  { name: "reject: empty type", input: wire({ type: "" }) },
  { name: "reject: type with a leading separator", input: wire({ type: ".instance.started" }) },
  { name: "reject: type with a space", input: wire({ type: "instance started" }) },
  { name: "reject: oversized type", input: wire({ type: "t".repeat(161) }) },
  { name: "reject: null envelope", input: null },
  { name: "reject: array envelope", input: [] },
  { name: "reject: string envelope", input: "{}" },
  { name: "reject: number envelope", input: 42 },

  // --- rejected payloads: numeric bounds and lifecycle phases -------------------------------------
  { name: "reject: contextPercent below 0", input: wire({ type: "instance.heartbeat", payload: { contextPercent: -0.01 } }) },
  { name: "reject: contextPercent above 100", input: wire({ type: "instance.heartbeat", payload: { contextPercent: 100.01 } }) },
  { name: "reject: non-finite contextPercent", input: wire({ type: "instance.heartbeat", payload: { contextPercent: Number.NaN } }) },
  { name: "reject: infinite contextPercent", input: wire({ type: "instance.updated", payload: { contextPercent: Number.POSITIVE_INFINITY } }) },
  { name: "reject: fractional pid", input: wire({ type: "instance.updated", payload: { pid: 1.5 } }) },
  { name: "reject: negative pid", input: wire({ type: "instance.updated", payload: { pid: -1 } }) },
  { name: "reject: instance.started without a status", input: wire({ type: "instance.started", payload: { displayName: "orion" } }) },
  { name: "reject: instance.started with an empty displayName", input: wire({ type: "instance.started", payload: { displayName: "", status: "active" } }) },
  { name: "reject: oversized string field", input: wire({ type: "instance.started", payload: { displayName: "d".repeat(1_025), status: "active" } }) },
  { name: "reject: instance.stopped without a reason", input: wire({ type: "instance.stopped", payload: {} }) },
  { name: "reject: agent.added without a label", input: wire({ type: "agent.added", payload: { id: "run-1", kind: "subagent", status: "running" } }) },
  { name: "reject: agent.updated without a patch", input: wire({ type: "agent.updated", payload: { id: "run-1" } }) },
  { name: "reject: agent.updated with an array patch", input: wire({ type: "agent.updated", payload: { id: "run-1", patch: [] } }) },
  { name: "reject: agent.updated with a non-string patch value", input: wire({ type: "agent.updated", payload: { id: "run-1", patch: { status: 3 } } }) },
  { name: "reject: agent.removed with a non-terminal status", input: wire({ type: "agent.removed", payload: { id: "run-1", status: "running" } }) },
  { name: "reject: tool.started already finished", input: wire({ type: "tool.started", payload: { callId: "tc-1", agentId: "run-1", name: "Bash", status: "done" } }) },
  { name: "reject: tool.finished still running", input: wire({ type: "tool.finished", payload: { callId: "tc-1", agentId: "run-1", name: "Bash", status: "running" } }) },
  { name: "reject: negative tool duration", input: wire({ type: "tool.finished", payload: { callId: "tc-1", agentId: "run-1", name: "Bash", status: "done", durationMs: -1 } }) },
  { name: "reject: message with a non-boolean expectsReply", input: wire({ type: "message.sent", payload: { ...MESSAGE, expectsReply: "yes" } }) },
  { name: "reject: negative message size", input: wire({ type: "message.sent", payload: { ...MESSAGE, size: -1 } }) },
  { name: "reject: fractional message size", input: wire({ type: "message.received", payload: { ...MESSAGE, size: 1.5 } }) },
  { name: "reject: message without an id", input: wire({ type: "message.replied", payload: { ...MESSAGE, id: "" } }) },
  { name: "reject: peers.snapshot with a non-array roster", input: wire({ type: "peers.snapshot", payload: { peers: {} } }) },
  { name: "reject: peer with a negative contextPercent", input: wire({ type: "peers.snapshot", payload: { peers: [{ ...PEER, contextPercent: -1 }] } }) },
  { name: "reject: peer with a non-finite contextPercent", input: wire({ type: "peers.snapshot", payload: { peers: [{ ...PEER, contextPercent: Number.NaN }] } }) },
  { name: "reject: peer with a negative sent count", input: wire({ type: "peers.snapshot", payload: { peers: [{ ...PEER, sent: -1 }] } }) },
  { name: "reject: peer with a fractional received count", input: wire({ type: "peers.snapshot", payload: { peers: [{ ...PEER, received: 1.5 }] } }) },
  { name: "reject: peer without a sessionId", input: wire({ type: "peers.snapshot", payload: { peers: [{ ...PEER, sessionId: "" }] } }) },
];

test("both parsers make the same accept/reject decision and projection on every corpus case", () => {
  for (const wireCase of CORPUS) {
    const parsed = parseTelemetryEvent(wireCase.input);
    if (wireCase.accept === undefined) {
      assert.equal(parsed, undefined, `${wireCase.name}: expected rejection`);
      continue;
    }
    assert.ok(parsed, `${wireCase.name}: expected acceptance`);
    assert.deepEqual(parsed, { ...(wireCase.input as Record<string, unknown>), version: 2, ...(wireCase.envelope ?? {}), payload: wireCase.accept }, wireCase.name);
  }
});

test("no corpus payload carries a canary past the parser", () => {
  const projected = CORPUS.map((wireCase) => JSON.stringify(parseTelemetryEvent(wireCase.input) ?? null)).join("");
  assert.equal(projected.includes("SECRET-CANARY"), false, "a projected payload leaked a sensitive field");
});

test("the corpus covers every known event type", () => {
  const covered = new Set(CORPUS.filter((wireCase) => wireCase.input && typeof wireCase.input === "object").map((wireCase) => (wireCase.input as Record<string, unknown>).type));
  for (const type of KNOWN_TYPES) {
    assert.ok(isKnownTelemetryEvent({ type } as unknown as TelemetryEvent), `${type} is missing from this parser's known-type set`);
    assert.ok(covered.has(type), `${type} has no corpus case`);
  }
});

// --- end of the shared block; everything below is consumer-local ---------------------------------

test("the known-event-type set is identical in protocol.ts and event-store.ts", () => {
  const parserTypes = setLiteral("../shared/protocol.ts", "const TYPES = new Set");
  const storeTypes = setLiteral("../src/event-store.ts", "const KNOWN_EVENT_TYPES = new Set");
  assert.deepEqual(parserTypes, [...KNOWN_TYPES].sort(), "shared/protocol.ts drifted from the shared corpus");
  assert.deepEqual(storeTypes, parserTypes, "EventStore.append blanks the payload of every type it does not know, so a type added to protocol.ts alone is silently zeroed on ingest");
});

/** The shared block IS the parity mechanism, so something has to enforce that the two copies stay
 *  one text: before this guard, a case added to one repo alone passed both suites. flow may depend on
 *  pi-persona and never the reverse, so the comparison lives here and only here. It skips rather than
 *  fails when no sibling checkout resolves \u2014 flow must stay testable standalone. */
const BLOCK_START = "// --- shared conformance corpus: byte-identical in both repos, change both or neither";
const BLOCK_END = "// --- end of the shared block; everything below is";

function sharedBlock(source: string, origin: string): string {
  const start = source.indexOf(BLOCK_START);
  const end = source.indexOf(BLOCK_END, start + 1);
  assert.ok(start >= 0 && end > start, `the shared-block banners no longer delimit the corpus in ${origin}`);
  return source.slice(source.indexOf("\n", start) + 1, end);
}

test("the shared corpus block is byte-identical to the pi-persona copy", (t) => {
  const corpusIn = (root: string) => `${root.replace(/[\\/]$/, "")}/test/unit/telemetry/parity.test.ts`;
  // An explicitly configured root that cannot be read is a misconfiguration, not a reason to quietly
  // validate against some other checkout.
  if (process.env.PI_PERSONA_REPO) {
    assert.ok(existsSync(corpusIn(process.env.PI_PERSONA_REPO)), `PI_PERSONA_REPO has no corpus at ${corpusIn(process.env.PI_PERSONA_REPO)}`);
  }
  const sibling = [process.env.PI_PERSONA_REPO, fileURLToPath(new URL("../../pi-persona/", import.meta.url))]
    .flatMap((root) => (root ? [corpusIn(root)] : []))
    .find((candidate) => existsSync(candidate));
  if (sibling === undefined) {
    t.skip("no pi-persona checkout resolves beside this one (set PI_PERSONA_REPO to enforce the corpus)");
    return;
  }
  const here = sharedBlock(readFileSync(new URL(import.meta.url), "utf8"), "this file").split("\n");
  const there = sharedBlock(readFileSync(sibling, "utf8"), sibling).split("\n");
  // Reported as one line rather than a whole-block diff: the block is ~17KB, and the useful answer is
  // which line moved.
  for (let line = 0; line < Math.max(here.length, there.length); line += 1) {
    assert.equal(
      here[line],
      there[line],
      `the conformance corpus diverged from ${sibling} at shared-block line ${line + 1} — a case belongs in both copies or neither, or one parser is validated against wire cases the other never sees`,
    );
  }
});

/* DIVERGENCE — the one behaviour this file deliberately does NOT share with
 * pi-persona/test/unit/telemetry/parity.test.ts. Given { contextPercent: NaN, sent: Infinity },
 * sanitizeTelemetryPayload returns {} here and returns it verbatim in the producer's contract.ts. The
 * disagreement between the two exported sanitizers is real — found by exercising both on the same
 * inputs during review — but it is
 * INERT on every caller either repo has today, so this pin describes drift, not a live bug: here
 * projectTelemetryPayload is reached only from parseTelemetryEvent, which rejects a known payload
 * carrying a non-finite number (containsNonFinite) and projects an unknown one to {}, and over there
 * the producer maps non-finite numbers to 0 before calling in. That is why every corpus case above
 * still agrees. Pinned rather than fixed because this test owns neither implementation; the fix is one
 * line in contract.ts's scalar branch — `if (typeof value === "number") return Number.isFinite(value) ?
 * value : undefined;` — and when it lands, delete this test and its producer twin. */
test("DIVERGENCE: sanitizeTelemetryPayload drops non-finite numbers here, contract.ts keeps them", () => {
  assert.deepEqual(sanitizeTelemetryPayload({ contextPercent: Number.NaN, sent: Number.POSITIVE_INFINITY }), {});
});
