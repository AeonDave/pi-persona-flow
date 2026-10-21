# Shared local dashboard service

- Status: accepted
- Date: 2026-10-19

## Outcome and boundaries

One already-open browser page discovers newly opened Pi workspaces and can switch among their
sessions and workflows. Ten concurrent Pi clients share one local service rather than ten listeners
and duplicate scans. Ending the first Pi must not end the other clients' dashboard.

The service is per canonical agent directory (one user/profile), not a system-wide Windows/systemd
installation. It is a detached Node process, launched lazily by the extension. No runtime dependency
on Pi or tsx is allowed in that process: the source uses Node 22.19+ native erasable TypeScript.
Node-only modules own HTTP, files, stores and leases; Pi lifecycle/UI stays in `src/extension.ts`.
Keep Pi 1.0 minimum-host tests and separately qualify installed Pi 1.3.

## Contracts

`shared/workspaces.ts` is the shared type boundary. Private registration includes cwd, workspace hash,
Pi session ID, a per-attachment random client ID and PID. The workspace ID remains `workspaceHash(cwd)`
from the existing producer contract; the label is a bounded basename, not an absolute path. Canonical
agent-dir resolution happens in the Pi adapter (`PI_AGENT_DIR || getAgentDir()`) and is passed to the
service. It never accepts an arbitrary agent directory from a browser request.

- `GET /api/workspaces`: browser-authenticated `WorkspaceCatalog`, no paths/control secrets.
- `GET /api/snapshot?workspace=<id>`: only that workspace's EventStore and cursor.
- `GET /api/stream?workspace=<id>&after=<cursor>&streamEpoch=<epoch>`: only that workspace's
  snapshots/deltas. Shared-service snapshots carry an independent public `streamEpoch`; SSE event
  IDs are `<epoch>:<cursor>`. An initial join forwards its HTTP snapshot's epoch; EventSource
  reconnects with its last event ID. A missing or obsolete epoch forces an authoritative snapshot,
  replacing the old graph and cursor before accepting events from the new daemon. Legacy standalone
  servers retain numeric event IDs.
- A missing workspace parameter uses the catalog default; an unknown explicit ID returns 404,
  never another workspace's data. Existing single-store server adapters expose one `local` workspace.
- `GET /internal/status`: private control authentication, returns `{ protocol: 1, serviceId }`.
- `POST /internal/register`: body `WorkspaceRegistration`, returns `{ workspaceId }`.
- `POST /internal/heartbeat`: body `{ clientId }`; unknown registration returns 404.
- `POST /internal/unregister`: body `{ clientId }`, idempotent.
- `POST /internal/ingest`: body `{ clientId, events }`; independently validate each event and reject
  foreign-workspace data. This forwards compatible bus-only producers as well as immediate file
  duplicates; EventStore deduplication remains authoritative. This route alone permits a bounded
  2 MiB body (ordinary private control bodies remain limited to 16 KiB).

Private routes require `x-pi-flow-control` with a random 256-bit token, reject browser Origin headers,
bound JSON bodies (16 KiB) and bind only to 127.0.0.1. Browser read-only routes retain the existing
four-character convenience gate and per-port cookie. Never expose the private descriptor or control token
in browser responses, public URLs, telemetry, or logs. No wildcard CORS.

`<agentDir>/persona-flow/service-v1/service.json` is a private atomic 0600 descriptor:
protocol, service ID/nonce, PID, browser URL, control token and start time. An authenticated status
probe verifies the descriptor, not PID existence alone. Startup contenders share an exclusive
`startup.lock` owned by PID+nonce; only a proven-dead owner can be reclaimed. Unknown/malformed
owners fail closed with a bounded actionable diagnostic. No broad process killing or deletion.

A separate private, atomic 0600 `<agentDir>/persona-flow/service-v1/browser.json` binding
retains the browser launch code, desired port and actual bound loopback port across daemon replacements.
With an unchanged desired port, a new daemon prefers this port and code so already-open browser pages keep their authenticated URL;
if the port has been taken, normal loopback port fallback supplies a new URL which Pi announces.
The browser binding is not control authentication: each daemon creates a fresh service ID and
private control token. Malformed saved bindings are rejected rather than used as authentication data.

The secondary `startup.lock.reclaim` guard is deliberately conservative after a crash: an unknown,
malformed or proven-dead reclaimer fails closed rather than risking deletion of a new contender's
lock. After confirming no Flow daemon or live Pi owns the profile, an operator may remove only that
stale reclaim file and retry. Never remove a live owner's lock or the whole profile directory.

The service entrypoint `src/service/entry.ts` accepts absolute agent-dir and desired-port arguments,
creates its own service ID/control token and descriptor, and owns descriptor cleanup on shutdown.
The client launcher holds the startup lock until that descriptor authenticates. Spawn detached with
hidden Windows window, ignored stdio and an error listener. A failed/cancelled attachment cannot
register after cancellation; an already-started shared service can exit through its idle lifecycle.

Backend API: `startSharedService({ agentDir, port, ...testLimits })` resolves a descriptor plus
`close()` and `clientCount()`; it starts one multiplexing HTTP server. The entrypoint persists the
descriptor and awaits the service lifecycle. Client API:
`connectFlowService({ agentDir, cwd, sessionId, port?, idleMs?, signal? })` returns
`{ url, workspaceId, heartbeat(): Promise<void>, publish(events: readonly unknown[]): Promise<void>, close(): Promise<void> }`.
Close unregisters only that client, never kills the shared service. A 404 heartbeat re-registers a
still-live attachment. Transport failures are non-fatal to Pi. Failed startup, heartbeat or bus delivery
starts automatic reconnection with bounded exponential backoff; no operator command is required for
ordinary service loss. Reconnection uses the same authenticated discovery and startup election as the
first attachment, so it can reuse a live daemon or start a replacement without taking ownership of its
lifetime. `/dashboard serve` can request an immediate attempt. Pending attachments and recovery share
one connection attempt; stop, shutdown and session replacement cancel scheduled retries, invalidate
late callbacks and close late connections. The Pi footer reports the interruption and restores the
current authenticated link when connected.

The Pi adapter batches bus delivery behind one in-flight request. Queued and in-flight events share
one outstanding budget of 256 events / 1 MiB. An ambiguous delivery is retried with identical event
IDs, including across reconnection, so service deduplication remains authoritative. Failed batches
remain pending within that budget; excess events are dropped with a visible overload warning.
Shutdown attempts the final bounded batch before unregistering, without scheduling further recovery.
Delivery is not durable or guaranteed: file-backed history can be read again after recovery, while
compatible bus-only producers should persist their own history if durable recovery matters.

## Lifetime and data

The service uses one EventStore/Tailer per registered workspace, with exact workspace filtering.
It aggregates compatible workspace logs, as before; Exocom membership never broadens filesystem
scope. `--no-flow` prevents this run from starting/registering with the viewer; it does not disable
producer telemetry or hide workspace logs from another enabled viewer. Producer opt-outs are separate.
Dedicated worker markers skip Flow registration. A user-set `PI_PERSONA_DISABLE` is not a worker.

Flow optionally reads `flowEnabled`, `flowPort`, and `flowIdleMs` from the version-1
`<agentDir>/persona/settings.json` `preferences` object at extension activation. This is a read-only
consumer; it does not import the producer runtime or write the shared file. Defaults are enabled,
port 7874, and a 60-second idle grace. `PI_PERSONA_FLOW_PORT` and `PI_PERSONA_FLOW_IDLE_MS` override
the corresponding saved values. `flowEnabled: false` suppresses automatic attachment only; an
explicit `/dashboard serve` may still attach, while `--no-flow` always opts that Pi run out. The
resolved port and idle grace are desired settings for a newly started service: an already-running
shared service is never restarted or reconfigured. Direct client callers may pass `idleMs` (50–60,000)
to configure only a daemon started by that call.

Clients heartbeat every 5 seconds; a 20-second lease expires crashed/disconnected clients. PID checks
are conservative (`ESRCH` proves death, permission/unknown does not). SDK sessions in the same process
have separate client IDs. Unregistering or expiry updates workspace active counts immediately;
recent workspace history remains navigable in the service's bounded lifetime. Cap retained workspace
stores (32) and active client registrations (256), never evict an active workspace, reject excess
active registrations clearly, and retire
inactive stores first. Existing EventStore bounds remain in force per workspace.

At initial startup, Flow waits up to 15 seconds for a first authenticated client, independently of
the desired idle grace, so short settings do not race the Pi client's 10-second startup deadline.
If no client ever connects, the daemon still exits after that bounded grace. After any Pi or browser
client has connected, idle shutdown occurs after the configured grace (60 seconds by default) with
no registrations and no browser SSE clients. An open browser SSE connection keeps the service alive,
so the idle grace is not a hard lifetime cap while a dashboard remains connected. No automatic browser-tab spawning is added: open the
shared page once with `/dashboard`, then leave it connected. `/dashboard stop` detaches this run only
and cancels its automatic recovery; `serve` reattaches it unless `--no-flow` was supplied.
`/dashboard status` prints the shared URL.

The browser polls the small catalog every 2 seconds, preserves a valid workspace URL selection,
and resets graph, filters, replay, selection and cursor on switching. Abort previous snapshot requests,
close the old EventSource and ignore late callbacks; identical producer/session IDs in two workspaces
must never mix. Catalog and snapshot requests have bounded deadlines. Failed initial snapshots are
retried automatically; a permanently closed EventSource rechecks the authenticated snapshot before
opening a replacement stream. Sources still reconnecting natively remain in use. On service-generation change,
discard the old numeric cursor and store before loading the replacement daemon's snapshot; a cursor
from a previous process must not skip or merge events in a new process. Use `useDashboard` fields
`workspaces`, `selectedWorkspaceId`, `selectWorkspace(id)`.

## Alternatives and verification

Per-Pi listeners were simple and isolated but multiply discovery/scans and URLs. Hosting inside the
first Pi makes shared lifetime depend on that process. A separate service adds startup election,
private control authentication and crash recovery, justified by the requested multi-workspace use.

Prove singleton startup across concurrent processes, distinct workspace/cursor isolation, service
survival after its first client exits, crash/lease recovery, opt-out, shutdown and packed native-Node
execution without development dependencies. Then exercise workspace discovery/switching in Playwright,
including late responses, reused IDs, empty/offline states, mobile layout and no idle animation loop.
