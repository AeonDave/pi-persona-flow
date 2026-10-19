/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { TelemetryEvent } from "../../shared/protocol";
import { createGraphState, reduceTelemetry } from "../../src/reducer";
import { Inspector, type EntityId } from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

function renderInspector(graph: ReturnType<typeof createGraphState>, selected: EntityId): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => { root!.render(createElement(Inspector, { graph, selected, onClose: () => {}, onSelect: () => {} })); });
  return host;
}

afterEach(() => {
  if (root) act(() => { root!.unmount(); });
  host?.remove();
  root = undefined;
  host = undefined;
});

const event = (seq: number, sessionId: string, type: string, payload: unknown): TelemetryEvent => ({
  version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: `inspect-${sessionId}-${seq}`, seq,
  ts: seq * 1000, sessionId, workspaceId: "0123456789abcdef01234567", type, payload,
} as unknown as TelemetryEvent);

describe("inspector history and replay selection", () => {
  it("explains when a selected node is absent at the replay position", () => {
    const content = renderInspector(createGraphState(), { type: "agent", key: "pi-persona::alpha::scout" });

    expect(content.textContent).toContain("This agent is not present at this replay position.");
    expect(content.textContent).not.toContain("Nothing selected");
  });

  it("exposes raw transport and reply correlation ids without message content", () => {
    let graph = reduceTelemetry(createGraphState(), event(1, "alpha", "instance.started", {
      displayName: "Alpha", status: "active",
    }));
    graph = reduceTelemetry(graph, event(2, "alpha", "message.sent", {
      id: "tool-call-stable-42", wireId: "wire-message-8f31", replyTo: "source-ask-91",
      channel: "exocom", from: "alpha", to: "beta", kind: "reply", status: "sent",
      expectsReply: false, size: 17,
    }));

    const content = renderInspector(graph, { type: "instance", key: "pi-persona::alpha" });
    const metadata = content.querySelector(".traffic-copy em");
    expect(metadata?.textContent).toContain("wire wire-messag");
    expect(metadata?.textContent).toContain("reply to source-ask");
    expect(metadata?.getAttribute("title")).toBe("Wire ID: wire-message-8f31\nReply to: source-ask-91");
    expect(content.textContent).not.toContain("message body");
  });

  it("states how many recent tool calls and traffic rows are shown", () => {
    let graph = reduceTelemetry(createGraphState(), event(1, "alpha", "instance.started", {
      displayName: "Alpha", status: "active",
    }));
    for (let index = 0; index < 15; index += 1) {
      graph = reduceTelemetry(graph, event(index + 2, "alpha", "tool.started", {
        callId: `call-${index}`, agentId: "main", name: `read-${index}`, status: "running",
      }));
    }
    for (let index = 0; index < 15; index += 1) {
      graph = reduceTelemetry(graph, event(index + 17, "alpha", "message.sent", {
        id: `message-${index}`, channel: "intercom", from: "alpha", to: "supervisor", kind: "status",
        status: "delivered", expectsReply: false, size: index,
      }));
    }

    const content = renderInspector(graph, { type: "instance", key: "pi-persona::alpha" });
    expect(content.textContent).toContain("TOOL CALLS · 12 of 15");
    expect(content.textContent).toContain("RECENT TRAFFIC · 5 of 15");
    expect(content.querySelectorAll(".tool-row")).toHaveLength(12);
    expect(content.querySelectorAll(".traffic-row")).toHaveLength(5);

    const moreTools = [...content.querySelectorAll("button")].find((button) => button.textContent === "Show 3 more tools");
    const moreTraffic = [...content.querySelectorAll("button")].find((button) => button.textContent === "Show 5 more traffic");
    expect(moreTools).toBeDefined();
    expect(moreTraffic).toBeDefined();
    act(() => { moreTools?.click(); moreTraffic?.click(); });
    expect(content.querySelectorAll(".tool-row")).toHaveLength(15);
    expect(content.querySelectorAll(".traffic-row")).toHaveLength(10);
    const lastTrafficPage = [...content.querySelectorAll("button")].find((button) => button.textContent === "Show 5 more traffic");
    expect(lastTrafficPage).toBeDefined();
    act(() => { lastTrafficPage?.click(); });
    expect(content.querySelectorAll(".traffic-row")).toHaveLength(15);
    expect(content.textContent).toContain("TOOL CALLS · 15");
    expect(content.textContent).toContain("RECENT TRAFFIC · 15");
    act(() => { root!.render(createElement(Inspector, { key: "replay:2", graph, selected: { type: "instance", key: "pi-persona::alpha" }, onClose: () => undefined, onSelect: () => undefined })); });
    expect(content.querySelectorAll(".tool-row")).toHaveLength(12);
    expect(content.querySelectorAll(".traffic-row")).toHaveLength(5);
  });
});
