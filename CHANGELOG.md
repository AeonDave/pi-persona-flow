# Changelog

## Unreleased

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
