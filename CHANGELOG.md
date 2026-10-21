# Changelog

## Unreleased

## [0.3.2](https://github.com/AeonDave/pi-persona-flow/compare/v0.3.1...v0.3.2) - 2026-10-21

- Recover automatically from failed startup and lost shared-service connections with bounded backoff,
  recreating the daemon through the existing startup election when needed. Restore the current Pi
  dashboard link after recovery; `/dashboard serve` remains an optional immediate retry.
- Retain the browser launch code and prefer the previous port on daemon recovery so an open dashboard
  can reconnect. Reset replay cursors across service generations and retry failed initial snapshots;
  announce a new URL if the previous port is occupied.
- Reopen browser streams closed by transient HTTP errors after rechecking an authenticated snapshot;
  cancel superseded callbacks and retries when changing workspaces or closing the dashboard.
- Retain pending live batches through reconnection with unchanged event IDs and one combined
  count/byte budget for queued and in-flight events. Report overflow, preserve file-backed history
  recovery, and cancel retries and late connections on stop or session replacement.
- Update the dashboard's Vite development dependency to 8.3.5 for its security fixes.

## [0.3.1](https://github.com/AeonDave/pi-persona-flow/compare/v0.3.0...v0.3.1) - 2026-10-20

- Read Flow's public attachment, port and idle preferences from pi-persona's version-1
  `persona/settings.json` without writing it or importing the producer runtime. Existing Flow port
  and idle environment variables still override saved values; `--no-flow` remains the per-run opt-out.
- Pass the desired idle grace only to a newly started shared service and give it a bounded startup
  grace to authenticate its first client, so short idle preferences cannot race cold startup.
- Warn once and use bounded defaults for malformed Flow settings rather than silently ignoring them.

## [0.3.0](https://github.com/AeonDave/pi-persona-flow/compare/v0.3.0-rc.1...v0.3.0) - 2026-10-19

- Promote the qualified `0.3.0-rc.1` candidate to stable. No production behavior changed; the
  Windows test fixtures now retry bounded temporary-profile cleanup after service shutdown. The
  candidate section below retains the complete feature and qualification notes.

## [0.3.0-rc.1](https://github.com/AeonDave/pi-persona-flow/compare/v0.2.0...v0.3.0-rc.1) - 2026-10-19

Candidate for maintainer testing; GitHub release publication is deferred until manual acceptance.

- Attach top-level Pi sessions by default to one detached local service per profile, with a
  live workspace menu and isolated stores/replay. Replace `--flow` with `--no-flow` (viewer
  attachment only, not a producer privacy switch). Closing one Pi no longer owns service lifetime;
  `/dashboard stop` detaches only that session. Skip delegated workers and keep headless startup
  off stdout. Bound startup election, leases, workspace retention, control requests and bus batches.
- Qualify the installed Pi 1.3 host with real pi-persona multi-session/worker telemetry and an
  offline synthetic provider. Exercise ten concurrent attachments sharing one listener and
  producer logs, native Node service startup, authenticated control and idle shutdown.
- Follow pi-persona's `PI_AGENT_DIR` override when reading telemetry; pin both Pi profile variables
  in tests so no operator telemetry is read.
- Make large topologies scrollable, disambiguate duplicate names, show actual dashboard-link
  state and explicit replay/list limits, and retain local font fallbacks. Compute active worker
  elapsed time from its own stream's recorded signals, with terminal/replay clocks pinned.
- Remove a platform-dependent inode-test assumption about floating-point decimal formatting.
- Preserve optional Exocom transport/reply correlation without creating a second lifecycle row.

## [0.2.0](https://github.com/AeonDave/pi-persona-flow/releases/tag/v0.2.0) - 2026-10-03

- Require Pi 1.0.0+ and Node.js 22.19.0+; host packages remain optional peers on `*`.
- Track liveness for agent/tool-only streams; retain work across stale/recovery transitions.
- Show known endpoint aliases in the inspector, preserving raw routing IDs in tooltips. Never
  identify historical engine handles by a matching bare agent name.
- Coalesce dashboard starts, cancel pending starts on stop, and reject unknown subcommands.
- Make `/dashboard serve` start without launching a browser.
- Avoid identical footer updates on every heartbeat.
- Upgrade the web toolchain and development dependencies, with no known audit vulnerabilities at
  qualification time; add pinned Windows/Linux/macOS CI.
- Exercise the real Pi 1.0 loader, authenticated HTTP, concurrency and shutdown offline.

Telemetry v1 data remains readable. This does not retain support for old Pi host APIs.
