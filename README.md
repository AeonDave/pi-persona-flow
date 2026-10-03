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

Restart Pi or run `/reload`, then:

```text
/dashboard
```

This starts the loopback server and opens its authenticated URL. The git install includes
the compiled web UI; users do not need to run Vite.

## Commands

```text
/dashboard         start and open the dashboard
/dashboard open    open the running dashboard
/dashboard serve   start without opening a browser
/dashboard status  show the current authenticated URL
/dashboard stop    stop the server, including a pending start
```

Autostart with `pi --flow`. To set it through the environment:

```bash
# Linux / macOS
PI_PERSONA_FLOW_AUTOSTART=1 pi
```

```powershell
# Windows PowerShell
$env:PI_PERSONA_FLOW_AUTOSTART = "1"
pi
```

Pi keeps a clickable line above the editor:

```text
flow dashboard at http://127.0.0.1:7874/?token=Ab0T
```

Use that link, or `/dashboard status`. A bare `http://127.0.0.1:7874` loads the page but
cannot authenticate the API. The launch code is random, case-sensitive and changes whenever
the server restarts.

Default port: `7874`; set `PI_PERSONA_FLOW_PORT` to override it (`0` asks the OS for a port).
If the requested port is occupied, Flow chooses an available loopback port and announces it.
Concurrent starts share one listener, and stopping cannot leave a late-started server behind.

Run Flow in **one session per workspace**. It tails every producer's workspace log; other
sessions need no dashboard of their own. Producers must use the same canonical workspace
and agent directory for file-backed aggregation.

## What you see

- Reporting Pi/plugin instances: display name, persona/model when supplied, context pressure
  and liveness.
- Nested workers, councils and flow phases, with their tool calls.
- Intercom traffic within one supervisor's run and exocom traffic between independent sessions.
- A bounded event timeline with live view and replay.
- A selected-node inspector with tool history and safe traffic metadata: direction, channel,
  size, reply linkage and time.

Names and aliases are shown when telemetry identifies the endpoint exactly. Raw routing IDs
remain available in the route's tooltip. Unknown engine handles stay raw: a matching bare
agent name is not enough to identify an older run safely.

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
**real Pi 1.0 SDK session**, authenticated HTTP access, start/stop races, stale-stream
recovery and web interaction regressions. CI runs on Windows, Ubuntu and macOS.

For browser acceptance, run `node --import tsx test-results/serve-fixture.mts`, open its printed
URL with Playwright CLI, then run `playwright-cli run-code --filename=scripts/browser-acceptance.cjs`.
It checks waiting/aliases, traffic, replay, safe payload projection and idle animation. The fixture
closes itself after ten minutes.

After packing and extracting into a temporary directory, run
`node --import tsx scripts/qualify-package.ts <package>/src/extension.ts` from this checkout to
verify the host loader, shipped web assets and shutdown independently of source-tree resolution.

## Architecture

```text
Compatible Pi plugins
  +-- pi.events: pi:telemetry -- immediate local delivery
  +-- JSONL: <agent-dir>/telemetry/v2/<workspace>/<producer>/<session>.jsonl
                                  |
                         TelemetryTailer
                                  |
                             EventStore
                                  |
                      deterministic graph reducer
                                  |
             loopback snapshot API + cursor-based SSE
                                  |
                  React controls, Canvas and replay
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
- `src/extension.ts`: commands, lifecycle and live event bus.
- `web/`: React/Vite UI; production output in `dist/web`.

## Security

The server binds only to `127.0.0.1`. A four-character Base62 launch code gates API and SSE;
a port-specific `HttpOnly` cookie keeps the browser connected. Arbitrary Host headers are
rejected; assets are same-origin, with CSP and no wildcard CORS or external fonts.

Concurrent SSE clients and slow-reader buffers are bounded. File ingestion bounds unfinished
lines, deduplicates bus/file copies, and caps retained events, messages and stream projections.
Windows browser launch uses `rundll32`, not `cmd /c start`.

The short code is a convenience gate for a **read-only local service**, not strong
authentication. Treat other processes running as your user as trusted. Do not expose or proxy
the dashboard off-host.

[Changes](CHANGELOG.md) · [MIT license](LICENSE)
