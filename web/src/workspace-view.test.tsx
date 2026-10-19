/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useWorkspaceViewState } from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

function Harness({ id }: { id: string }) {
  const view = useWorkspaceViewState(id);
  return createElement("div", null,
    createElement("span", { "data-testid": "instance-filter" }, view.filters.instance),
    createElement("span", { "data-testid": "channel-filter" }, view.filters.channel),
    createElement("span", { "data-testid": "attention-filter" }, view.filters.attention),
    createElement("span", { "data-testid": "cursor" }, view.cursor === undefined ? "live" : String(view.cursor)),
    createElement("span", { "data-testid": "selected" }, view.selected?.key ?? "none"),
    createElement("span", { "data-testid": "playing" }, String(view.playing)),
    createElement("button", { onClick: () => {
      view.setFilters({ instance: "pi-persona::old", persona: "reviewer", channel: "exocom", attention: "attention" });
      view.setCursor(37);
      view.setSelected({ type: "agent", key: "pi-persona::old::agent" });
      view.setPlaying(true);
    } }, "populate old workspace state"),
  );
}

function render(workspaceId: string): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => { root!.render(createElement(Harness, { id: workspaceId })); });
  return host;
}

afterEach(() => {
  if (root) act(() => { root!.unmount(); });
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("workspace-scoped view state", () => {
  it("resets filters, replay, playback and selection when the workspace changes", () => {
    const content = render("workspace-a");
    act(() => { (content.querySelector("button") as HTMLButtonElement).click(); });
    expect(content.querySelector('[data-testid="instance-filter"]')?.textContent).toBe("pi-persona::old");
    expect(content.querySelector('[data-testid="cursor"]')?.textContent).toBe("37");
    expect(content.querySelector('[data-testid="selected"]')?.textContent).toBe("pi-persona::old::agent");

    act(() => { root!.render(createElement(Harness, { id: "workspace-b" })); });
    expect(content.querySelector('[data-testid="instance-filter"]')?.textContent).toBe("");
    expect(content.querySelector('[data-testid="channel-filter"]')?.textContent).toBe("all");
    expect(content.querySelector('[data-testid="attention-filter"]')?.textContent).toBe("all");
    expect(content.querySelector('[data-testid="cursor"]')?.textContent).toBe("live");
    expect(content.querySelector('[data-testid="selected"]')?.textContent).toBe("none");
    expect(content.querySelector('[data-testid="playing"]')?.textContent).toBe("false");
  });
});
