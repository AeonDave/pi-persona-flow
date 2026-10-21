<h1 align="center">pi-persona-flow</h1>

<p align="center">
  A local control room for Pi instances, workers, tools and message traffic.
</p>

See what reporting Pi sessions are doing, live or in replay. Flow reads lifecycle telemetry
and draws the topology; it does not infer progress from an agent's prose.

[pi-persona](https://github.com/AeonDave/pi-persona) is the current rich producer. Flow also
works with any plugin emitting the vendor-neutral `pi:telemetry` v2 contract. It has no hard
dependency on pi-persona or [pi-persona-mind](https://github.com/AeonDave/pi-persona-mind).

## Install

Requires **Pi 1.0.0+** and **Node.js 22.19.0+**. Windows, Linux and macOS are supported.

```bash
# Full-featured producer; optional if another plugin emits compatible telemetry
pi install npm:@aeondave/pi-persona

# Dashboard
pi install git:github.com/AeonDave/pi-persona-flow
```

For a reproducible install of this stable release, pin the tag:

```bash
pi install git:github.com/AeonDave/pi-persona-flow@v0.3.2
```

Restart Pi or run `/reload`. Flow attaches to one shared local service automatically,
without opening browser tabs. Open the dashboard once:

```text
/dashboard
```

Keep that tab open. Its **Workspace** menu updates as other Pi sessions attach; switch projects,
then inspect their sessions, workers and workflows. The git install includes the compiled UI;
users do not need to run Vite or install a system service.

## Commands

```text
/dashboard         start and open the dashboard
/dashboard open    open the running dashboard
/dashboard serve   attach or retry immediately without opening a browser
/dashboard status  show the current authenticated URL
/dashboard stop    detach this session, including a pending attachment
```

To prevent this Pi run from starting or attaching to the viewer:

```bash
pi --no-flow
```

The opt-out applies to `/dashboard` too. Start a new Pi run without it to enable Flow again.
The old `--flow` flag and `PI_PERSONA_FLOW_AUTOSTART` setting are no longer used.
This does **not** disable another plugin's telemetry producer: an enabled viewer can still
read its compatible workspace logs. It is a viewer opt-out, not a telemetry privacy switch.

Pi keeps a clickable line above the editor:

```text
flow dashboard at http://127.0.0.1:7874/?token=Ab0T
```

Use that link, or `/dashboard status`. A bare `http://127.0.0.1:7874` loads the page but
cannot authenticate the API. The random, case-sensitive launch code is retained across service
restarts, so an open dashboard can reconnect automatically. If another process takes its port,
Flow announces a new URL in Pi.

Default port: `7874`; set `PI_PERSONA_FLOW_PORT` to override it (`0` asks the OS for a port).
When pi-persona is installed, Flow also reads its version-1 `persona/settings.json` preferences
without writing them: `flowEnabled` controls automatic attachment, `flowPort` selects the desired
port and `flowIdleMs` (50–60,000; default 60,000) selects the desired idle grace. The existing
`PI_PERSONA_FLOW_PORT` and `PI_PERSONA_FLOW_IDLE_MS` environment variables override saved values.
`flowEnabled: false` disables automatic attachment, not an explicit `/dashboard serve`; `--no-flow`
always opts that Pi run out. Port and idle choices apply only when a new shared service starts,
never to one already running. If the requested port is occupied, Flow chooses an available loopback port and announces it.
Simultaneous starts elect **one detached service per Pi agent directory**, with one URL and
launch code. Closing the first Pi, or running `/dashboard stop`, does not stop the others.
On first startup, the service allows up to 15 seconds for its first authenticated client; this lets
even a short idle preference survive a slow cold start. After a client has connected, the service
exits after the configured idle grace with no attached Pi sessions and no dashboard SSE connections.
An open dashboard keeps the service alive and can review retained work. No OS-wide daemon is installed.
Delegated workers do not attach as extra supervisors. Headless autostart announces its URL on
stderr, keeping JSON/RPC/print stdout clean. Flow automatically retries failed startup and lost
connections with bounded backoff, starting a replacement service when needed. No recovery command
is required; `/dashboard serve` requests an immediate attempt. The Pi footer shows connection state
and restores the dashboard link after recovery. Pending live events stay within a bounded buffer;
overflow is reported, and compatible file-backed history remains available after reconnecting.

Each workspace has a separate event store, file tailer, replay cursor and graph. Changing it
resets scoped filters, replay and selection; old requests cannot populate the new view.
The menu lists up to 32 active/recent workspaces and shows attached-session counts (not worker
counts); the service admits up to 256 attached sessions. New active workspaces never evict
another active workspace.

File-backed aggregation requires the same workspace identity and agent directory. Flow
honors `PI_AGENT_DIR` just like pi-persona, otherwise Pi's own agent directory is used.
Exocom does not merge workspaces: a foreign-workspace peer can appear in traffic/presence,
but its private agents and tools are not imported into this workspace's graph. To inspect the
other workspace's own data, select it in the menu after one of its Pi sessions attaches.

## What you see

- Reporting Pi/plugin instances: display name, persona/model when supplied, context pressure
  and liveness.
- Nested workers, councils and flow phases, with their tool calls.
- Intercom traffic within one supervisor's run and exocom traffic between independent sessions.
- A bounded event timeline with live view and replay.
- A selected-node inspector with tool history and safe traffic metadata: direction, channel,
  size, reply linkage and time.

Exocom transport IDs (`wireId`) are separate from stable telemetry-row IDs. Queued and terminal
updates reuse one row; reply references use the transport ID. IDs are exposed as metadata,
never recovered by guessing from message text or timestamps.
Optional correlation fields appear only when the installed producer emits them; older producers
remain compatible without those fields.

Names and aliases are shown when telemetry identifies the endpoint exactly. Raw routing IDs
remain available in the route's tooltip. Unknown engine handles stay raw: a matching bare
agent name is not enough to identify an older run safely.

Duplicate supervisor names are disambiguated in the instance selector. The graph scrolls
when many instances or workers exceed the viewport. Inspector lists disclose their limits
and can reveal more retained items.

Replay follows **recorded ingestion order**, preserving per-stream sequence order. It is
not a globally synchronized wall-clock timeline: historical files can arrive in batches,
and different processes can have skewed clocks. Counts describe the retained event window
(up to 5,000 events), not lifetime totals. The dashboard-link indicator reports its SSE
connection, not the health of every worker.

Agent elapsed time uses the latest recorded signal from its own producer/session, or its explicit
end time. It is not a viewer wall-clock estimate; replay does not keep advancing a historical run.

`waiting` means the **producer explicitly reports a pending supervisor reply**. Flow does
not mistake an old ask for a stalled worker or infer waiting from tool output. A producer
that omits the status cannot supply that distinction.

When a stream stops reporting, LIVE view hides its stale card, including producers that
emit only agent/tool events. Its recorded work stays intact for REVIEW; fresh activity
restores liveness. Instance and agent status are separate: loss of a heartbeat does not
rewrite a running agent as failed.

Selecting an instance scopes traffic to that stream and the peers it observed. Exocom from
unrelated instances does not leak through. Traffic animates only while a send is `queued`;
delivered history stays still. Reduced motion disables the animation, and an idle canvas
does not run a continuous animation loop.

## Local development

```bash
npm ci
npm --prefix web ci
npm run typecheck:all
npm run test:all
npm run build
npm audit --audit-level=low
npm --prefix web audit --audit-level=low
pi -e ./src/extension.ts
```

Rebuild after web changes: `dist/web` is shipped with the package. Tests include an isolated
**real Pi 1.0 SDK session**, authenticated HTTP access, shared-service election/attachment races,
workspace isolation, stale-stream recovery and web interaction regressions. CI runs on Windows,
Ubuntu and macOS.

For browser acceptance, run `node --import tsx test-results/serve-fixture.mts`, open its printed
URL with Playwright CLI, then run `playwright-cli run-code --filename=scripts/browser-acceptance.cjs`.
It checks waiting/aliases, traffic, replay, safe payload projection and idle animation. Then run
`playwright-cli run-code --filename=scripts/browser-acceptance-many.cjs` for ten Pi sessions,
duplicate names, long inspector lists, scrolling and mobile layout. The fixture closes itself
after ten minutes.

For the actual shared service, run `node --import tsx test-results/serve-workspaces.mts` in an
interactive terminal, then run `scripts/browser-acceptance-workspaces.cjs` through Playwright CLI.
It checks two isolated workspaces with ten sessions, switching, replay reset, URL persistence and
responsive layout. Enter `add` in the fixture terminal to see a new workspace appear without reload.
Close its browser tab before entering `stop`, so the fixture can join idle shutdown and remove its
temporary profile.

For the installed Pi 1.3.0 host (optional second path loads the current pi-persona producer):

```bash
node --import tsx scripts/qualify-host.mjs <absolute-pi-package-root> [<absolute-pi-persona-extension-path>]
```

This uses temporary profiles and a local synthetic model, not cloud credentials. It checks
default startup, `--no-flow`, clean headless stdout, authenticated HTTP and actual multi-session
producer/worker telemetry. It is host-integration proof, not a live-provider quality test.

After packing and extracting into a temporary directory, run
`node --import tsx scripts/qualify-package.ts <package>/src/extension.ts` from this checkout to
verify the host loader, shipped web assets and shutdown independently of source-tree resolution.

## Architecture

```text
Pi sessions + compatible telemetry producers
                    |
        one detached local service per Pi profile
                    |
       +------------+-------------+
       |                          |
  Workspace A                Workspace B
  Tailer + store             Tailer + store
       |                          |
       +------------+-------------+
                    |
        workspace-scoped snapshot API / SSE
                    |
       one dashboard, workspace menu and replay
```

The wire contract is version `2`. Legacy v1 `pi-persona:telemetry` files remain readable;
this is data compatibility, not support for pre-1.0 Pi hosts. Stream identity is
`(producerId, sessionId)`, so different plugins can reuse session IDs without collisions.

Producers emit bounded semantic metadata, never prompts, model output, tool arguments,
paths, secrets or message bodies. Unknown namespaced events retain the envelope but project
their unregistered payload to `{}`.

Key files:

- `shared/protocol.ts`: wire vocabulary and parser.
- `src/tailer.ts`: appended JSONL ingestion.
- `src/event-store.ts` and `src/reducer.ts`: dedupe, bounded replay and graph state.
- `src/server.ts`: loopback static/API/SSE server.
- `src/service/`: authenticated attachment, startup election and detached service lifecycle.
- `src/extension.ts`: thin Pi adapter, bounded live-event batches and commands.
- `web/`: React/Vite UI; production output in `dist/web`.

The accepted [shared-service design](docs/SHARED_SERVICE.md) documents identity, leases,
shutdown, HTTP contracts and qualification boundaries.

## Security

The server binds only to `127.0.0.1`. A four-character Base62 launch code gates API and SSE;
a port-specific `HttpOnly` cookie keeps the browser connected. Arbitrary Host headers are
rejected; assets are same-origin, with CSP and no wildcard CORS or external fonts.

Concurrent SSE clients and slow-reader buffers are bounded. File ingestion bounds unfinished
lines, deduplicates bus/file copies, and caps retained events, messages and stream projections.
Windows browser launch uses `rundll32`, not `cmd /c start`.

Pi attachments use a separate long random control token in a private profile descriptor,
not the short browser code. Private registration/ingestion routes reject browser Origins;
the public workspace catalog contains IDs and safe labels, never absolute filesystem paths.

The short code is a convenience gate for a **read-only local service**, not strong
authentication. Treat other processes running as your user as trusted. Do not expose or proxy
the dashboard off-host.

[Changes](CHANGELOG.md) · [MIT license](LICENSE)
