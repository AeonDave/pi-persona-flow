# Changelog

## Unreleased

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
