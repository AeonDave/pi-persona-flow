import { describe, expect, it } from "vitest";
import type { TelemetryEvent } from "../../shared/protocol";
import { createGraphState, reduceTelemetry } from "../../src/reducer";
import { computeLayout, distinctPeers, inFlightTraffic, messagesForSelection, modelLabel } from "./App";

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
  });
});
