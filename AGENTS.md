# AGENTS.md — pi-persona-flow

A standalone, read-only Pi telemetry viewer. The wire boundary is `shared/protocol.ts`; consumers
validate independently of producers. README documents the contract and local trust boundary.

## Commands

- `npm ci` and `npm --prefix web ci`.
- `npm run typecheck:all`, `npm run test:all`, `npm run build`.
- Audit both roots: `npm audit --audit-level=low`, `npm --prefix web audit --audit-level=low`.
- One backend test: `node --import tsx --import ./test/setup/hermetic-env.ts --test test/<name>.test.ts`.

## Invariants

- Pi 1.0.0+ / Node 22.19.0+. Host peers stay `*`; coordinated development host pins qualify the floor.
- Never derive lifecycle or identities from prompt/tool-result prose. Unknown endpoint IDs stay raw;
  bare agent-name matching is not a safe historical identity mapping. Human aliases are display only.
- Preserve stream identity `(producerId, sessionId)` and the producer/consumer parity corpus.
- A stale stream is a consumer liveness notice, not a failed worker. Preserve recorded agent/tool
  status and replay history; agent/tool-only producers must age out too.
- Pending starts share one promise; stop/session replacement invalidates and closes late listeners.
- Loopback only, bounded SSE and file ingestion, no body/prompt/argument/path/secret telemetry.
- No idle animation loop. Respect reduced motion, and avoid duplicate Pi footer updates.
- Pure TS must be erasable. Use platform-neutral paths and newline handling; never shell URLs through
  `cmd /c start`. Preserve intentional v1 data readability, not obsolete Pi host APIs.

## Done

Fresh typecheck, backend/web suites, build, both audits and `npm pack --dry-run`. Exercise the real Pi
SDK tests and the compiled dashboard, not only mocks. Rebuild tracked `dist/web` after final web edits.
Tests use an isolated Pi profile; never read or mutate the operator's memory, auth or telemetry.
