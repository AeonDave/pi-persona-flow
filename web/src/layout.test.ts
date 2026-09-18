import { describe, expect, it } from "vitest";
import type { TelemetryEvent } from "../../shared/protocol";
import { createGraphState, reduceTelemetry } from "../../src/reducer";
import { agentTitle, computeLayout, displayAgentStatus, distinctPeers, formatElapsed, inFlightTraffic, messageRoute, messagesForSelection, modelLabel, rankCanvasTools, shouldAnimateTraffic, siblingColumns, toolOwnerKey, toolsForSelection } from "./App";
import { livePresence } from "./state";

const instance = (seq: number, type: "instance.started" | "agent.added", payload: TelemetryEvent["payload"]): TelemetryEvent => ({
  version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: `test-${seq}`, seq, ts: seq * 1000, sessionId: "alpha", workspaceId: "0123456789abcdef01234567", type, payload,
} as unknown as TelemetryEvent);

describe("control-room layout", () => {
  it("renders presence-only exocom peers as selectable external nodes", () => {
    const graph = reduceTelemetry(createGraphState(), {
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "peer-1", seq: 1, ts: 1000, sessionId: "alpha", workspaceId: "0123456789abcdef01234567",
      type: "peers.snapshot", payload: { peers: [{ sessionId: "remote", displayName: "Remote", persona: "reviewer", model: "test", contextPercent: 10, status: "online", sent: 1, received: 2 }] },
    } as unknown as TelemetryEvent);
    const layout = computeLayout(graph, 900, 600);
    expect(layout.rects.some((rect) => rect.entity.type === "peer" && rect.entity.key === "pi-persona::alpha::remote")).toBe(true);
  });

  it("keeps instance and nested agent placement deterministic", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, instance(1, "instance.started", {
      displayName: "Alpha", persona: "operator", model: "test-model", status: "active", pid: 42, contextPercent: 28, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, instance(2, "agent.added", {
      id: "scout", label: "Scout", kind: "subagent", status: "running", parentId: undefined, task: "inspect",
    }));
    const first = computeLayout(graph, 900, 600);
    const second = computeLayout(graph, 900, 600);
    expect(first.rects).toEqual(second.rects);
    expect(first.rects.map((rect) => rect.entity.type)).toEqual(["instance", "agent"]);
    expect(first.links.some((link) => link.channel === "hierarchy")).toBe(true);
  });

  it("does not classify an extensible future channel as exocom", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, instance(1, "instance.started", {
      displayName: "Alpha", persona: "operator", model: "test-model", status: "active", pid: 42, contextPercent: 28, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, {
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "message-2", seq: 2, ts: 2000,
      sessionId: "alpha", workspaceId: "0123456789abcdef01234567", type: "message.sent",
      payload: { id: "m1", channel: "future.plugin", from: "alpha", to: "alpha", kind: "signal", status: "delivered", expectsReply: false, size: 0 },
    } as unknown as TelemetryEvent);
    const links = computeLayout(graph, 900, 600).links.filter((link) => link.channel !== "hierarchy");
    expect(links).toHaveLength(1);
    expect(links[0]?.channel).toBe("other");
  });

  it("an exocom peer that is already an instance is not drawn a second time", () => {
    // Every pi reports the others in its peers.snapshot, and a peer entry is keyed OBSERVER::OBSERVED
    // — so three mutually-visible instances produce six peer entries whose names duplicate the three
    // cards above. A peer node is for a pi we have no telemetry log of; one that already has a card
    // is the same process, not a second participant.
    let graph = createGraphState();
    const started = (session: string, name: string, seq: number) => ({
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "i-" + session, seq, ts: seq * 1000,
      sessionId: session, workspaceId: "0123456789abcdef01234567", type: "instance.started",
      payload: { displayName: name, persona: "elite", model: "p/m", status: "active", pid: seq, contextPercent: 5, exocomEnabled: true },
    }) as unknown as TelemetryEvent;
    const sees = (observer: string, observed: string, name: string, seq: number) => ({
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "p-" + observer + observed, seq, ts: seq * 1000,
      sessionId: observer, workspaceId: "0123456789abcdef01234567", type: "peers.snapshot",
      payload: { peers: [{ sessionId: observed, displayName: name, persona: "elite", model: "p/m", contextPercent: 5, status: "online", sent: 1, received: 1 }] },
    }) as unknown as TelemetryEvent;
    graph = reduceTelemetry(graph, started("s-rune", "rune", 1));
    graph = reduceTelemetry(graph, started("s-oslo", "oslo", 1));
    graph = reduceTelemetry(graph, started("s-iris", "iris", 1));
    graph = reduceTelemetry(graph, sees("s-oslo", "s-rune", "rune", 2));
    graph = reduceTelemetry(graph, sees("s-rune", "s-oslo", "oslo", 2));
    graph = reduceTelemetry(graph, sees("s-iris", "s-rune", "rune", 2));
    // …and one genuine stranger: a pi nobody has a log for. That one MUST keep its node.
    graph = reduceTelemetry(graph, sees("s-oslo", "s-ghost", "ghost", 3));

    const layout = computeLayout(graph, 1400, 900);
    expect(layout.rects.filter((r) => r.entity.type === "peer").map((r) => r.label).sort()).toEqual(["ghost"]);
    expect(layout.rects.filter((r) => r.entity.type === "instance")).toHaveLength(3);
  });

  it("a stopped instance is not drawn, even if another pi still lists it as a peer", () => {
    let graph = createGraphState();
    const started = (session: string, name: string) => ({
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "i-" + session, seq: 1, ts: 1000,
      sessionId: session, workspaceId: "0123456789abcdef01234567", type: "instance.started",
      payload: { displayName: name, persona: "elite", model: "p/m", status: "active", pid: 1, contextPercent: 5, exocomEnabled: true },
    }) as unknown as TelemetryEvent;
    graph = reduceTelemetry(graph, started("s-you", "you"));
    graph = reduceTelemetry(graph, started("s-hermes", "hermes"));
    graph = reduceTelemetry(graph, {
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "stop", seq: 2, ts: 2000,
      sessionId: "s-hermes", workspaceId: "0123456789abcdef01234567", type: "instance.stopped",
      payload: { reason: "shutdown" },
    } as unknown as TelemetryEvent);
    graph = reduceTelemetry(graph, {
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "p-1", seq: 2, ts: 2000,
      sessionId: "s-you", workspaceId: "0123456789abcdef01234567", type: "peers.snapshot",
      payload: { peers: [{ sessionId: "s-hermes", displayName: "hermes", persona: "elite", model: "p/m", contextPercent: 5, status: "online", sent: 0, received: 0 }] },
    } as unknown as TelemetryEvent);

    const layout = computeLayout(graph, 1400, 900);
    expect(layout.rects.map((r) => r.label)).not.toContain("hermes");
    expect(layout.rects.filter((r) => r.entity.type === "instance").map((r) => r.label)).toEqual(["you"]);
  });

  it("two instances both seeing the same stranger draw it once, not twice", () => {
    let graph = createGraphState();
    const sees = (observer: string) => ({
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "p-" + observer, seq: 1, ts: 1000,
      sessionId: observer, workspaceId: "0123456789abcdef01234567", type: "peers.snapshot",
      payload: { peers: [{ sessionId: "s-ghost", displayName: "ghost", persona: "elite", model: "p/m", contextPercent: 5, status: "online", sent: 0, received: 0 }] },
    }) as unknown as TelemetryEvent;
    graph = reduceTelemetry(graph, sees("s-oslo"));
    graph = reduceTelemetry(graph, sees("s-rune"));
    expect(computeLayout(graph, 1400, 900).rects.filter((r) => r.entity.type === "peer")).toHaveLength(1);
  });

  it("the model label drops the provider path and the billing suffix", () => {
    // The card showed `short(model, 15)` — a constant that clipped
    // "openrouter/poolside/laguna-s-2.1:free" to "openrouter/pool…", hiding the only part that
    // identifies the model, on a card with room to spare.
    expect(modelLabel("openrouter/poolside/laguna-s-2.1:free")).toBe("laguna-s-2.1");
    expect(modelLabel("openrouter/tencent/hy4-preview")).toBe("hy4-preview");
    expect(modelLabel("claude-pro-max-native/claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(modelLabel("test-model")).toBe("test-model");
    expect(modelLabel(undefined)).toBe("");
    expect(agentTitle("duskull-spectre-digest · glm-5.3", "openrouter/z-ai/glm-5.3")).toBe("duskull-spectre-digest");
    expect(agentTitle("Scout", "provider/model")).toBe("Scout");
    expect(formatElapsed(8_000)).toBe("8s");
    expect(formatElapsed(8 * 60_000)).toBe("8m");
    expect(formatElapsed(3 * 3_600_000 + 26 * 60_000)).toBe("3h 26m");
  });

  it("an exocom edge between two known instances links their cards, not vanished peer nodes", () => {
    // Suppressing the duplicate peer node must not drop the edge with it: the connection between two
    // pi instances is the whole point of the exocom layer, and it now has to land on the card.
    let graph = createGraphState();
    const started = (session: string, name: string) => ({
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "i-" + session, seq: 1, ts: 1000,
      sessionId: session, workspaceId: "0123456789abcdef01234567", type: "instance.started",
      payload: { displayName: name, persona: "elite", model: "p/m", status: "active", pid: 1, contextPercent: 5, exocomEnabled: true },
    }) as unknown as TelemetryEvent;
    graph = reduceTelemetry(graph, started("s-oslo", "oslo"));
    graph = reduceTelemetry(graph, started("s-rune", "rune"));
    graph = reduceTelemetry(graph, {
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "p-1", seq: 2, ts: 2000,
      sessionId: "s-oslo", workspaceId: "0123456789abcdef01234567", type: "peers.snapshot",
      payload: { peers: [{ sessionId: "s-rune", displayName: "rune", persona: "elite", model: "p/m", contextPercent: 5, status: "online", sent: 1, received: 0 }] },
    } as unknown as TelemetryEvent);
    graph = reduceTelemetry(graph, {
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "m-1", seq: 3, ts: 3000,
      sessionId: "s-oslo", workspaceId: "0123456789abcdef01234567", type: "message.sent",
      payload: { id: "m1", channel: "exocom", from: "s-oslo", to: "s-rune", kind: "message", status: "delivered", expectsReply: false, size: 10 },
    } as unknown as TelemetryEvent);

    const layout = computeLayout(graph, 1400, 900);
    expect(layout.links.filter((l) => l.channel === "exocom")).toHaveLength(1);
    expect(layout.links.find((l) => l.channel === "exocom")?.active).toBe(false);
  });

  it("channel edges animate only while telemetry says the message is still in flight", () => {
    // `delivered` is a terminal projection, not a live packet. Animating it made every past
    // intercom/exocom exchange crawl forever. The producer publishes `queued` for the open
    // tool call and replaces that same id when the result lands.
    expect(inFlightTraffic("queued")).toBe(true);
    expect(inFlightTraffic("delivered")).toBe(false);
    expect(inFlightTraffic("replied")).toBe(false);
    expect(inFlightTraffic("failed")).toBe(false);
    expect(inFlightTraffic("rejected")).toBe(false);
    expect(shouldAnimateTraffic("queued", false)).toBe(true);
    expect(shouldAnimateTraffic("queued", true)).toBe(false);

    let graph = createGraphState();
    const started = (session: string, name: string) => ({
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "i-" + session, seq: 1, ts: 1000,
      sessionId: session, workspaceId: "0123456789abcdef01234567", type: "instance.started",
      payload: { displayName: name, persona: "elite", model: "p/m", status: "active", pid: 1, contextPercent: 5, exocomEnabled: true },
    }) as unknown as TelemetryEvent;
    graph = reduceTelemetry(graph, started("s-oslo", "oslo"));
    graph = reduceTelemetry(graph, started("s-rune", "rune"));
    const sent = (id: string, seq: number, status: string) => ({
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id, seq, ts: seq * 1000,
      sessionId: "s-oslo", workspaceId: "0123456789abcdef01234567", type: "message.sent",
      payload: { id, channel: "exocom", from: "s-oslo", to: "s-rune", kind: "message", status, expectsReply: false, size: 10 },
    }) as unknown as TelemetryEvent;
    graph = reduceTelemetry(graph, sent("m-old", 2, "delivered"));
    graph = reduceTelemetry(graph, sent("m-live", 3, "queued"));
    const live = computeLayout(graph, 1400, 900).links.filter((l) => l.channel === "exocom");
    expect(live).toHaveLength(1);
    expect(live[0]?.active).toBe(true);

    graph = reduceTelemetry(graph, sent("m-live", 4, "delivered"));
    const done = computeLayout(graph, 1400, 900).links.filter((l) => l.channel === "exocom");
    expect(done).toHaveLength(1);
    expect(done[0]?.active).toBe(false);
  });

  it("the peer count reports peers, not observations of them", () => {
    // A peers.snapshot REPLACES that observer's set, so the duplication comes from each pi listing
    // all the others at once: three mutually-visible instances hold six entries for three processes,
    // and a tile reading "EXOCOM PEERS 6" beside three cards is just wrong.
    let graph = createGraphState();
    const roster = (observer: string, others: string[]) => ({
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "p-" + observer, seq: 1, ts: 1000,
      sessionId: observer, workspaceId: "0123456789abcdef01234567", type: "peers.snapshot",
      payload: { peers: others.map((id) => ({ sessionId: id, displayName: id, persona: "elite", model: "p/m", contextPercent: 5, status: "online", sent: 0, received: 0 })) },
    }) as unknown as TelemetryEvent;
    graph = reduceTelemetry(graph, roster("s-oslo", ["s-rune", "s-iris"]));
    graph = reduceTelemetry(graph, roster("s-rune", ["s-oslo", "s-iris"]));
    graph = reduceTelemetry(graph, roster("s-iris", ["s-oslo", "s-rune"]));

    expect(Object.keys(graph.peers).length).toBe(6);
    expect(distinctPeers(graph)).toBe(3);
  });

  it("the instance inspector lists intercom traffic owned by that stream", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, instance(1, "instance.started", {
      displayName: "Alpha", persona: "operator", model: "test-model", status: "active", pid: 42, contextPercent: 28, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, instance(2, "agent.added", {
      id: "scout", label: "Scout", kind: "subagent", status: "running", parentId: undefined, task: "inspect",
    }));
    graph = reduceTelemetry(graph, {
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: "m-ic", seq: 3, ts: 3000,
      sessionId: "alpha", workspaceId: "0123456789abcdef01234567", type: "message.sent",
      payload: { id: "ask-1", channel: "intercom", from: "supervisor", to: "scout", kind: "ask", status: "queued", expectsReply: true, size: 8 },
    } as unknown as TelemetryEvent);
    const traffic = messagesForSelection(graph.messages, { type: "instance", key: "pi-persona::alpha" });
    expect(traffic.map((message) => message.id)).toEqual(["ask-1"]);
    expect(graph.messages[0]?.fromKey).toBe("pi-persona::alpha::supervisor");
    expect(messageRoute(traffic[0]!, { type: "instance", key: "pi-persona::alpha" })).toBe("supervisor → scout");
    expect(messageRoute(traffic[0]!, { type: "agent", key: "pi-persona::alpha::scout" })).toBe("IN ← supervisor");
  });

  const toolCall = (seq: number, callId: string, agentId: string, name: string, status: "running" | "done" | "failed", durationMs?: number): TelemetryEvent => ({
    version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: `tool-${seq}`, seq, ts: seq * 1000,
    sessionId: "alpha", workspaceId: "0123456789abcdef01234567",
    type: status === "running" ? "tool.started" : "tool.finished",
    payload: status === "running"
      ? { callId, agentId, name, status }
      : { callId, agentId, name, status, durationMs: durationMs ?? 10 },
  } as unknown as TelemetryEvent);

  it("canvas chips are live and failed calls only, capped at three", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, instance(1, "instance.started", {
      displayName: "you", persona: "elite", model: "kimi-k3", status: "active", pid: 1, contextPercent: 6, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, instance(2, "agent.added", {
      id: "ember", label: "ember-rust-patterns · kimi-k3", kind: "subagent", status: "running", agent: "operator", model: "openrouter/kimi-k3",
    }));
    for (let index = 0; index < 12; index += 1) {
      graph = reduceTelemetry(graph, toolCall(10 + index * 2, `tc-${index}`, "ember", "read", "running"));
      graph = reduceTelemetry(graph, toolCall(11 + index * 2, `tc-${index}`, "ember", "read", "done", 20 + index));
    }
    for (let index = 0; index < 4; index += 1) {
      graph = reduceTelemetry(graph, toolCall(50 + index * 2, `fail-${index}`, "ember", "bash", "running"));
      graph = reduceTelemetry(graph, toolCall(51 + index * 2, `fail-${index}`, "ember", "bash", "failed", 4));
    }
    graph = reduceTelemetry(graph, toolCall(80, "tc-live", "ember", "grep", "running"));

    const layout = computeLayout(graph, 900, 600);
    const agent = layout.rects.find((rect) => rect.entity.type === "agent");
    const chips = layout.rects.filter((rect) => rect.entity.type === "tool");
    expect(agent?.label).toBe("ember-rust-patterns");
    expect(agent?.detail).toContain("kimi-k3");
    expect(agent?.detail).toContain("4 failed");
    expect(chips).toHaveLength(3);
    expect(new Set(chips.map((rect) => rect.y)).size).toBe(1);
    expect(chips.every((rect) => (
      rect.x >= agent!.x && rect.y >= agent!.y
      && rect.x + rect.width <= agent!.x + agent!.width + 0.5
      && rect.y + rect.height <= agent!.y + agent!.height + 0.5
    ))).toBe(true);
    expect(chips.some((rect) => rect.label === "grep" && rect.status === "running")).toBe(true);
    expect(chips.filter((rect) => rect.status === "failed")).toHaveLength(2);
    expect(agent?.meta).toBe("+2");
    expect(rankCanvasTools(Object.values(graph.tools)).visible[0]?.name).toBe("grep");
  });

  it("pins tools with no agent card onto the instance — that is the main Pi", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, instance(1, "instance.started", {
      displayName: "you", persona: "elite", model: "kimi-k3", status: "active", pid: 1, contextPercent: 6, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, toolCall(2, "tc-main", "you", "read", "running"));
    const layout = computeLayout(graph, 900, 600);
    const root = layout.rects.find((rect) => rect.entity.type === "instance");
    const chips = layout.rects.filter((rect) => rect.entity.type === "tool");
    expect(layout.rects.some((rect) => rect.entity.type === "agent")).toBe(false);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.label).toBe("read");
    expect(root && chips[0] && chips[0].y >= root.y && chips[0].y + chips[0].height <= root.y + root.height).toBe(true);
    expect(root?.detail).toContain("kimi-k3");
    // exocomEnabled was parsed but never shown; an idle-but-joined instance looked isolated.
    expect(root?.detail).toContain("exocom");
    expect(root?.contextPercent).toBe(6);
    expect(toolOwnerKey(Object.values(graph.tools)[0]!, new Set())).toBe("pi-persona::alpha");
    expect(toolsForSelection(graph, { type: "instance", key: "pi-persona::alpha" }).map((tool) => tool.callId)).toEqual(["tc-main"]);
  });

  it("LIVE presence hides concluded subagents; REVIEW layout still has them", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, instance(1, "instance.started", {
      displayName: "dev", persona: "dev", model: "openrouter/z-ai/glm-5.3", status: "idle", pid: 1, contextPercent: 36, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, instance(2, "agent.added", {
      id: "done-run", label: "duskull-spectre-digest · glm-5.3", kind: "subagent", status: "done", agent: "operator", model: "openrouter/z-ai/glm-5.3",
    }));
    graph = reduceTelemetry(graph, instance(3, "agent.added", {
      id: "live-run", label: "shuppet-wraith-digest · glm-5.3", kind: "subagent", status: "running", agent: "operator", model: "openrouter/z-ai/glm-5.3",
    }));
    graph = reduceTelemetry(graph, toolCall(4, "old-read", "done-run", "read", "running"));
    graph = reduceTelemetry(graph, toolCall(5, "old-read", "done-run", "read", "done", 20));

    const live = livePresence(graph);
    expect(Object.keys(live.agents)).toEqual(["pi-persona::alpha::live-run"]);
    expect(Object.keys(live.tools)).toEqual([]);
    expect(computeLayout(live, 900, 600).rects.filter((rect) => rect.entity.type === "agent").map((rect) => rect.label)).toEqual(["shuppet-wraith-digest"]);

    const reviewed = computeLayout(graph, 900, 600);
    expect(reviewed.rects.filter((rect) => rect.entity.type === "agent")).toHaveLength(2);
    const done = reviewed.rects.find((rect) => rect.label === "duskull-spectre-digest");
    expect(done?.status).toBe("done");
    expect(done?.detail).toContain("glm-5.3");
    expect(done?.span).toBeDefined();
  });

  it("LIVE drops a concluded failed run; a failed stamp with live tools still shows as running", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, instance(1, "instance.started", {
      displayName: "dev", persona: "dev", model: "openrouter/z-ai/glm-5.3", status: "active", pid: 1, contextPercent: 40, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, instance(2, "agent.added", {
      id: "dead-run", label: "phantump-transport-loop · glm-5.3", kind: "subagent", status: "failed", agent: "operator", model: "openrouter/z-ai/glm-5.3",
    }));
    graph = reduceTelemetry(graph, instance(3, "agent.added", {
      id: "hurt-run", label: "larvitar-platform-finish · glm-5.2", kind: "subagent", status: "failed", agent: "operator", model: "openrouter/z-ai/glm-5.2",
    }));
    graph = reduceTelemetry(graph, toolCall(4, "live-read", "hurt-run", "read", "running"));
    graph = reduceTelemetry(graph, toolCall(5, "old-bash", "hurt-run", "bash", "running"));
    graph = reduceTelemetry(graph, toolCall(6, "old-bash", "hurt-run", "bash", "failed", 4));

    expect(displayAgentStatus("failed", { running: 1 })).toBe("running");
    expect(displayAgentStatus("failed", { running: 0 })).toBe("failed");

    const live = computeLayout(livePresence(graph), 721, 571);
    expect(live.rects.filter((rect) => rect.entity.type === "agent").map((rect) => `${rect.label}:${rect.status}`)).toEqual(["larvitar-platform-finish:running"]);
    expect(live.rects.find((rect) => rect.label === "larvitar-platform-finish")?.detail).toContain("1 failed");
    expect(live.rects.find((rect) => rect.label === "larvitar-platform-finish")?.detail).toContain("1 live");
  });

  it("sibling cards wrap instead of overlapping when the canvas is the live inspector width", () => {
    expect(siblingColumns(4, 400)).toEqual({ cols: 2, itemWidth: 176 });
    expect(siblingColumns(4, 621).cols).toBe(4);

    let graph = createGraphState();
    graph = reduceTelemetry(graph, instance(1, "instance.started", {
      displayName: "dev", persona: "dev", model: "glm-5.3", status: "active", pid: 1, contextPercent: 40, exocomEnabled: true,
    }));
    for (let index = 0; index < 7; index += 1) {
      graph = reduceTelemetry(graph, instance(2 + index, "agent.added", {
        id: `run-${index}`, label: `agent-${index}`, kind: "subagent", status: "running",
      }));
    }
    const layout = computeLayout(graph, 721, 571);
    const agents = layout.rects.filter((rect) => rect.entity.type === "agent");
    expect(agents).toHaveLength(7);
    expect(new Set(agents.map((rect) => rect.y)).size).toBeGreaterThan(1);
    for (let i = 0; i < agents.length; i += 1) {
      for (let j = i + 1; j < agents.length; j += 1) {
        const a = agents[i]!;
        const b = agents[j]!;
        const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlap, `${a.label} overlaps ${b.label}`).toBe(false);
      }
    }
    const chips = layout.rects.filter((rect) => rect.entity.type === "tool");
    expect(chips.every((chip) => agents.some((agent) => (
      chip.x >= agent.x && chip.y >= agent.y
      && chip.x + chip.width <= agent.x + agent.width + 0.5
      && chip.y + chip.height <= agent.y + agent.height + 0.5
    )))).toBe(true);
  });

  it("keeps descendants inside their sibling subtree instead of stacking them", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, instance(1, "instance.started", {
      displayName: "dev", persona: "dev", model: "m", status: "active", pid: 1, contextPercent: 20, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, instance(2, "agent.added", { id: "left", label: "left", kind: "delegate", status: "running" }));
    graph = reduceTelemetry(graph, instance(3, "agent.added", { id: "right", label: "right", kind: "delegate", status: "running" }));
    graph = reduceTelemetry(graph, instance(4, "agent.added", { id: "left-child", label: "left-child", kind: "subagent", status: "running", parentId: "left" }));
    graph = reduceTelemetry(graph, instance(5, "agent.added", { id: "right-child", label: "right-child", kind: "subagent", status: "running", parentId: "right" }));

    const children = computeLayout(graph, 721, 571).rects.filter((rect) => rect.label.endsWith("child"));
    expect(children).toHaveLength(2);
    const [left, right] = children;
    const overlap = left!.x < right!.x + right!.width && left!.x + left!.width > right!.x
      && left!.y < right!.y + right!.height && left!.y + left!.height > right!.y;
    expect(overlap).toBe(false);
  });

  it("places the next instance row below a deep tree", () => {
    let graph = createGraphState();
    const started = (sessionId: string, displayName: string): TelemetryEvent => ({
      version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: `${sessionId}-1`, seq: 1, ts: 1000,
      sessionId, workspaceId: "0123456789abcdef01234567", type: "instance.started",
      payload: { displayName, persona: "dev", model: "m", status: "active", pid: 1, contextPercent: 20, exocomEnabled: true },
    });
    graph = reduceTelemetry(graph, started("alpha", "Alpha"));
    graph = reduceTelemetry(graph, started("beta", "Beta"));
    graph = reduceTelemetry(graph, started("gamma", "Gamma"));
    graph = reduceTelemetry(graph, instance(2, "agent.added", { id: "depth-1", label: "depth-1", kind: "delegate", status: "running" }));
    graph = reduceTelemetry(graph, instance(3, "agent.added", { id: "depth-2", label: "depth-2", kind: "delegate", status: "running", parentId: "depth-1" }));
    graph = reduceTelemetry(graph, instance(4, "agent.added", { id: "depth-3", label: "depth-3", kind: "delegate", status: "running", parentId: "depth-2" }));

    const rects = computeLayout(graph, 721, 571).rects;
    const deep = rects.find((rect) => rect.label === "depth-3")!;
    const next = rects.find((rect) => rect.label === "Gamma")!;
    const overlap = deep.x < next.x + next.width && deep.x + deep.width > next.x
      && deep.y < next.y + next.height && deep.y + deep.height > next.y;
    expect(overlap).toBe(false);
  });
});
