/** @vitest-environment jsdom */
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TelemetryEvent } from "../../shared/protocol";
import { createGraphState, reduceTelemetry, type GraphState } from "../../src/reducer";
import { filterGraph, livePresence, useTimelineView, type Filters, type TimelineView } from "./state";

/** The fold is the cost this view is measured by, so the test counts it rather than timing it. */
vi.mock("../../src/reducer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/reducer")>();
  return { ...actual, reduceTelemetry: vi.fn(actual.reduceTelemetry) };
});
const folds = vi.mocked(reduceTelemetry);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const event = (seq: number, type: "instance.started" | "instance.updated", payload: TelemetryEvent["payload"]): TelemetryEvent => ({
  version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: `timeline-${seq}`, seq, ts: seq * 1000, sessionId: "alpha", workspaceId: "0123456789abcdef01234567", type, payload,
} as unknown as TelemetryEvent);

const started = event(1, "instance.started", { displayName: "Alpha", persona: "operator", model: "test", status: "active", pid: 1, contextPercent: 1, exocomEnabled: true });
/** One event per percent, so a reconstructed graph names the position it was rebuilt at. */
const updates = Array.from({ length: 29 }, (_, index) => event(index + 2, "instance.updated", { contextPercent: index + 2 }));
const KEY = "pi-persona::alpha";

function percentOf(graph: GraphState): number | undefined {
  return graph.instances[KEY]?.contextPercent;
}

/** Drives the hook through a real StrictMode root, the way main.tsx mounts the app, so the render-phase
 *  freeze is exercised against the double render rather than only against a single clean pass. */
function mountTimeline(): { show: (graph: GraphState, cursor: number | undefined) => TimelineView; unmount: () => void } {
  let latest: TimelineView | undefined;
  const Probe = ({ graph, cursor }: { graph: GraphState; cursor: number | undefined }): null => {
    latest = useTimelineView(graph, cursor);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  return {
    show(graph, cursor) {
      act(() => { root.render(createElement(StrictMode, null, createElement(Probe, { graph, cursor }))); });
      return latest!;
    },
    unmount() { act(() => { root.unmount(); }); },
  };
}

describe("timeline reconstruction", () => {
  it("rebuilds the graph at the selected event instead of reusing live state", () => {
    const timeline = mountTimeline();
    const live = [started, updates[0]!].reduce((graph, next) => reduceTelemetry(graph, next), createGraphState());
    timeline.show(live, undefined);
    const review = timeline.show(live, 0).graph;
    expect(percentOf(live)).toBe(2);
    expect(percentOf(review)).toBe(1);
    expect(review.events).toHaveLength(1);
    timeline.unmount();
  });
});

describe("review mode", () => {
  it("holds the reviewed graph still while deltas keep arriving", () => {
    const timeline = mountTimeline();
    let live = [started, ...updates.slice(0, 9)].reduce((graph, next) => reduceTelemetry(graph, next), createGraphState());
    timeline.show(live, undefined);
    const reviewed = timeline.show(live, 3).graph;
    expect(percentOf(reviewed)).toBe(4);

    for (const update of updates.slice(9, 14)) {
      live = reduceTelemetry(live, update);
      const during = timeline.show(live, 3);
      // Identity, not just contents: a fresh graph object here means the whole window was re-folded on
      // the main thread for this delta, and every consumer memo downstream was invalidated with it.
      expect(during.graph).toBe(reviewed);
      expect(during.events).toHaveLength(10);
    }
    timeline.unmount();
  });

  it("steps the cursor forward by folding only the events crossed", () => {
    const timeline = mountTimeline();
    const live = [started, ...updates].reduce((graph, next) => reduceTelemetry(graph, next), createGraphState());
    timeline.show(live, undefined);
    folds.mockClear();
    expect(percentOf(timeline.show(live, 24).graph)).toBe(25);
    expect(folds.mock.calls).toHaveLength(25);
    folds.mockClear();
    const stepped = timeline.show(live, 28).graph;
    expect(percentOf(stepped)).toBe(29);
    expect(folds.mock.calls).toHaveLength(4);
    timeline.unmount();
  });

  it("keeps following the stream when review is entered before the first event arrives", () => {
    const timeline = mountTimeline();
    const empty = createGraphState();
    timeline.show(empty, undefined);
    // REVIEW hands the hook the slider maximum, which is 1 while the log is still empty.
    expect(timeline.show(empty, 1).events).toHaveLength(0);

    // An empty log is not a reviewable moment: freezing it would strand the dashboard on nothing while
    // the stream fills, and only the return-to-live button could recover it.
    const live = [started, ...updates.slice(0, 5)].reduce((graph, next) => reduceTelemetry(graph, next), createGraphState());
    const filled = timeline.show(live, 1);
    expect(filled.events).toHaveLength(6);
    expect(percentOf(filled.graph)).toBe(2);

    // The freeze still latches: it just waits for a log worth holding, so the moment the user lands on
    // does not slide once the stream is running.
    const during = timeline.show(reduceTelemetry(live, updates[5]!), 1);
    expect(during.events).toHaveLength(6);
    expect(during.graph).toBe(filled.graph);
    timeline.unmount();
  });

  it("drops the replay cache on the way back to live", () => {
    const timeline = mountTimeline();
    const live = [started, ...updates.slice(0, 9)].reduce((graph, next) => reduceTelemetry(graph, next), createGraphState());
    timeline.show(live, undefined);
    timeline.show(live, 4);
    timeline.show(live, undefined);

    // Re-entering an unchanged log pays for the full fold again — the price of not pinning a frozen log
    // and its reconstruction for the lifetime of the page.
    folds.mockClear();
    expect(percentOf(timeline.show(live, 4).graph)).toBe(5);
    expect(folds.mock.calls).toHaveLength(5);
    timeline.unmount();
  });

  it("returns to live fully caught up and re-enters review on the newer log", () => {
    const timeline = mountTimeline();
    let live = [started, ...updates.slice(0, 9)].reduce((graph, next) => reduceTelemetry(graph, next), createGraphState());
    timeline.show(live, undefined);
    timeline.show(live, 0);
    for (const update of updates.slice(9, 19)) live = reduceTelemetry(live, update);

    const back = timeline.show(live, undefined);
    expect(back.graph).toBe(live);
    expect(back.events).toHaveLength(20);
    expect(percentOf(back.graph)).toBe(20);

    const reentered = timeline.show(live, 19);
    expect(percentOf(reentered.graph)).toBe(20);
    expect(reentered.events).toHaveLength(20);
    timeline.unmount();
  });
});

const ALL: Filters = { instance: "", persona: "", channel: "all", attention: "all" };

const v2 = (session: string, seq: number, type: string, payload: object) => ({
  version: 2, producerId: "pi-persona", producerVersion: "1.10.5",
  id: `${session}-${seq}`, seq, ts: seq * 1000, sessionId: session,
  workspaceId: "0123456789abcdef01234567", type, payload,
} as unknown as TelemetryEvent);

function workspaceGraph(): GraphState {
  let graph = createGraphState();
  const started = (session: string, persona: string) => v2(session, 1, "instance.started", {
    displayName: session, persona, model: "m", status: "active", pid: 1, contextPercent: 1, exocomEnabled: true,
  });
  graph = reduceTelemetry(graph, started("alpha", "operator"));
  graph = reduceTelemetry(graph, started("beta", "reviewer"));
  graph = reduceTelemetry(graph, v2("alpha", 2, "peers.snapshot", {
    peers: [{ sessionId: "beta", displayName: "beta", persona: "reviewer", model: "m", contextPercent: 1, status: "online", sent: 1, received: 0 }],
  }));
  graph = reduceTelemetry(graph, v2("beta", 2, "peers.snapshot", {
    peers: [{ sessionId: "alpha", displayName: "alpha", persona: "operator", model: "m", contextPercent: 1, status: "online", sent: 0, received: 1 }],
  }));
  graph = reduceTelemetry(graph, v2("alpha", 3, "message.sent", {
    id: "exo-a", channel: "exocom", from: "alpha", to: "beta", kind: "message", status: "delivered", expectsReply: false, size: 1,
  }));
  graph = reduceTelemetry(graph, v2("beta", 3, "message.sent", {
    id: "exo-b", channel: "exocom", from: "beta", to: "alpha", kind: "message", status: "delivered", expectsReply: false, size: 1,
  }));
  graph = reduceTelemetry(graph, v2("alpha", 4, "message.sent", {
    id: "ic-a", channel: "intercom", from: "supervisor", to: "scout", kind: "ask", status: "queued", expectsReply: true, size: 1,
  }));
  return graph;
}

describe("instance filter", () => {
  it("keeps only the selected stream's messages and the peers that stream observed", () => {
    const graph = workspaceGraph();
    const scoped = filterGraph(graph, { ...ALL, instance: "pi-persona::alpha" });
    expect(Object.keys(scoped.instances)).toEqual(["pi-persona::alpha"]);
    expect(scoped.messages.map((message) => message.id).sort()).toEqual(["exo-a", "ic-a"]);
    expect(Object.keys(scoped.peers)).toEqual(["pi-persona::alpha::beta"]);
  });

  it("does not let the other instance's exocom through just because the channel is exocom", () => {
    const scoped = filterGraph(workspaceGraph(), { ...ALL, instance: "pi-persona::alpha", channel: "exocom" });
    expect(scoped.messages.map((message) => message.id)).toEqual(["exo-a"]);
  });
});

describe("live presence", () => {
  it("drops a closed Pi so a leftover --exocom session is not live topology", () => {
    let graph = workspaceGraph();
    graph = reduceTelemetry(graph, v2("beta", 10, "instance.stopped", { reason: "shutdown" }));
    const live = livePresence(graph);
    expect(Object.keys(live.instances)).toEqual(["pi-persona::alpha"]);
    expect(Object.keys(live.peers)).toEqual([]);
    expect(live.messages.map((message) => message.id).sort()).toEqual(["exo-a", "ic-a"]);
  });

  it("does not resurrect a stopped peer from a live observer's last snapshot", () => {
    let graph = workspaceGraph();
    graph = reduceTelemetry(graph, v2("beta", 10, "instance.stopped", { reason: "shutdown" }));
    // Alpha still names beta — that snapshot is history, not presence.
    expect(Object.keys(graph.peers)).toContain("pi-persona::alpha::beta");
    expect(Object.keys(livePresence(graph).peers)).not.toContain("pi-persona::alpha::beta");
  });

  it("keeps tools that belong to a live instance even when they have no agent card", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, v2("alpha", 1, "instance.started", {
      displayName: "you", persona: "elite", model: "m", status: "active", pid: 1, contextPercent: 1, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, v2("alpha", 2, "tool.started", {
      callId: "tc-1", agentId: "you", name: "read", status: "running",
    }));
    expect(Object.keys(livePresence(graph).tools)).toHaveLength(1);
  });

  it("drops concluded subagents from LIVE, including a failed run with no live work", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, v2("alpha", 1, "instance.started", {
      displayName: "dev", persona: "dev", model: "m", status: "idle", pid: 1, contextPercent: 36, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, v2("alpha", 2, "agent.added", {
      id: "done-run", label: "done-run", kind: "subagent", status: "done",
    }));
    graph = reduceTelemetry(graph, v2("alpha", 3, "agent.added", {
      id: "fail-run", label: "fail-run", kind: "subagent", status: "failed",
    }));
    graph = reduceTelemetry(graph, v2("alpha", 4, "tool.started", {
      callId: "tc-done", agentId: "done-run", name: "read", status: "running",
    }));
    graph = reduceTelemetry(graph, v2("alpha", 5, "tool.finished", {
      callId: "tc-done", agentId: "done-run", name: "read", status: "done", durationMs: 10,
    }));
    const live = livePresence(graph);
    expect(Object.keys(live.agents)).toEqual([]);
    expect(Object.keys(live.tools)).toEqual([]);
    expect(Object.keys(graph.agents)).toHaveLength(2);
  });

  it("keeps a failed stamp on LIVE when that agent still has a running tool", () => {
    let graph = createGraphState();
    graph = reduceTelemetry(graph, v2("alpha", 1, "instance.started", {
      displayName: "dev", persona: "dev", model: "m", status: "active", pid: 1, contextPercent: 10, exocomEnabled: true,
    }));
    graph = reduceTelemetry(graph, v2("alpha", 2, "agent.added", {
      id: "fail-run", label: "fail-run", kind: "subagent", status: "running",
    }));
    graph = reduceTelemetry(graph, v2("alpha", 3, "tool.started", {
      callId: "tc-bad", agentId: "fail-run", name: "bash", status: "running",
    }));
    graph = reduceTelemetry(graph, v2("alpha", 4, "tool.finished", {
      callId: "tc-bad", agentId: "fail-run", name: "bash", status: "failed", durationMs: 4,
    }));
    graph = reduceTelemetry(graph, v2("alpha", 5, "tool.started", {
      callId: "tc-live", agentId: "fail-run", name: "read", status: "running",
    }));
    graph = reduceTelemetry(graph, v2("alpha", 6, "agent.updated", {
      id: "fail-run", patch: { status: "failed" },
    }));
    const live = livePresence(graph);
    expect(Object.keys(live.agents)).toEqual(["pi-persona::alpha::fail-run"]);
    expect(Object.values(live.tools).map((tool) => `${tool.name}:${tool.status}`).sort()).toEqual(["bash:failed", "read:running"]);
  });
});
