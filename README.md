<h1 align="center">pi-persona-flow</h1>

<p align="center">
  A local, real-time <b>control room</b> for Pi plugin lifecycle telemetry —
  instances, delegated agents, tools, and live
  <code>intercom</code> / <code>exocom</code> traffic, on a token-gated loopback dashboard.
</p>

A Pi extension that watches the workspace telemetry log and draws what compatible plugins are
actually doing: every reporting Pi, nested orchestration, tool lifecycle, and directional message
traffic. [pi-persona](https://github.com/AeonDave/pi-persona) is the current rich producer, not a
hard-coded contract owner. Edges animate only while a send is still `queued`; delivered history
stays still, and the animation is disabled when the OS requests reduced motion. Lifecycle truth is
emitted by the producer — this dashboard never infers orchestration from tool-result text.

> Flow is a viewer, not a producer. Install [pi-persona](https://github.com/AeonDave/pi-persona)
> for the complete intercom/exocom/orchestration view available today, or use any plugin that emits
> the vendor-neutral `pi:telemetry` v2 contract. Flow does not import or special-case pi-persona.
>
> Optional sibling: [pi-persona-mind](https://github.com/AeonDave/pi-persona-mind) (durable memory).
> Flow does not depend on it.

## Install

```bash
# Current full-featured producer (optional if another plugin emits pi:telemetry v2)
pi install git:github.com/AeonDave/pi-persona

# This dashboard
pi install git:github.com/AeonDave/pi-persona-flow
```

Restart Pi or `/reload`. Then, in any one session of the workspace:

```text
/dashboard
```

That starts the loopback server and opens a URL containing a random, case-sensitive four-character
Base62 launch code, for example `?token=Ab0T`. Do not type
`http://127.0.0.1:7874` by hand — the page loads, `/api/snapshot` returns 401, and the room stays
empty. Use `/dashboard status` to copy the link if the browser did not open.

```text
/dashboard         start the server and open the dashboard
/dashboard open    open the running dashboard
/dashboard status  show its URL and current summary
/dashboard stop    stop it
```

Autostart:

```bash
pi --flow
# or
PI_PERSONA_FLOW_AUTOSTART=1 pi
```

On start, Pi shows a persistent line you can click:

```text
flow dashboard at http://127.0.0.1:7874/?token=…
```

The footer also names `127.0.0.1:<port>`. Do not type the port by itself — without the token the page loads and then sits empty on a 401. `/dashboard status` reprints the same link; `/dashboard` opens it in the browser.

Default port is `7874` (`PI_PERSONA_FLOW_PORT` to override). If that port is taken, the extension
binds an OS-assigned loopback port instead — which is why the announced URL matters.

Run the dashboard in **one** session. It tails every producer's log for that workspace; the other
sessions need nothing extra. All sessions must share the same working directory — the workspace id
is the path.

## What you see

- every reporting Pi/plugin instance: persona, model, context pressure, status;
- nested agents (delegates, council, flow phases) and their tools;
- **intercom** — supervisor ↔ child, inside one pi-persona run;
- **exocom** — flat traffic between independent Pi instances in the same workspace;
- a bounded, replayable event timeline and a selected-node inspector;
- click or keyboard-selectable cards with producer/session identity, derived live status, tool
  history, and safe traffic metadata (direction, channel, size, reply linkage, and time).

Selecting one instance scopes the canvas to **that stream's** messages and the peers it observed.
Exocom from other instances does not leak through. Channel lines move only while telemetry says
the send is still in flight (`queued`).

## Local development

The git install already includes `dist/web`. From a source checkout:

```bash
npm ci
npm --prefix web ci
npm run build
npm run test:all
npm run typecheck:all
pi -e ./src/extension.ts
```

## Architecture

```text
Any compatible Pi plugin (pi-persona is the current rich producer)
  ├─ pi.events: pi:telemetry (+ legacy v1) ─ immediate local delivery
  └─ JSONL  <agent-dir>/telemetry/v2/<workspace>/<producer>/<session>.jsonl
                                         │
                                         ▼
TelemetryTailer ──► EventStore ──► deterministic graph reducer
                         │
                         ├─ GET /api/snapshot  { cursor, state }
                         └─ GET /api/stream    cursor-based SSE
                                         │
                                         ▼
React controls + Canvas topology + timeline replay
```

The contract is version `2` on `pi:telemetry`. Legacy v1 (`pi-persona:telemetry`) files are still
read. Identity, sequence, and entity scope are `(producerId, sessionId)`. Producers must emit
bounded semantic metadata only — never model output, prompts, tool arguments, paths, secrets, or
message bodies. Unknown namespaced envelopes stay observable; their unregistered payload is `{}`.

Key files:

- `shared/protocol.ts` — versioned envelope and parser;
- `src/tailer.ts` — namespaced JSONL ingestion;
- `src/event-store.ts` — dedupe, cursor, bounded replay;
- `src/reducer.ts` — instances, agents, tools, messages, peers;
- `src/server.ts` — authenticated loopback static/API/SSE server;
- `src/extension.ts` — `/dashboard`, `--flow`, live event-bus;
- `web/` — React/Vite dashboard (production output `dist/web`).

## Security

- binds only to `127.0.0.1`;
- a random four-character Base62 launch code gates API and SSE and is minted per server start;
- arbitrary `Host` headers are rejected to prevent DNS-rebinding access;
- same-origin static assets, CSP, no wildcard CORS, no external fonts;
- tails only appended file bytes and bounds unterminated lines;
- deduplicates live-bus and JSONL copies by producer/session/event identity;
- caps retained events, messages, and completed stream projections;
- marks instances stale when heartbeats stop; LIVE topology hides stopped/stale Pi so a closed `--exocom` session does not linger as a card (REVIEW still scrubs the log);
- Windows `/dashboard` opens via `rundll32` (never `cmd /c start`).

The short code is intentionally a human-readable convenience gate for a read-only service bound to
loopback, not strong authentication (four Base62 characters provide about 23.8 bits). Other local
processes running as the same user should be treated as trusted; do not expose or proxy this server
off-host.
