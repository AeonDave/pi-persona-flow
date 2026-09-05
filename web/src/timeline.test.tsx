/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEvent } from "../../shared/protocol";
import { Timeline } from "./App";
import { reconcileFilters, type Filters } from "./state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const event = (seq: number): TelemetryEvent => ({
  version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: `tl-${seq}`, seq, ts: seq * 1000,
  sessionId: "alpha", workspaceId: "0123456789abcdef01234567", type: "instance.heartbeat", payload: { contextPercent: seq },
} as unknown as TelemetryEvent);

interface Harness { host: HTMLElement; root: Root; onCursor: ReturnType<typeof vi.fn>; onPlay: ReturnType<typeof vi.fn> }
let live: Harness | undefined;

function show(events: readonly TelemetryEvent[], cursor: number | undefined, playing = false): Harness {
  const harness = live ?? (() => {
    const host = document.createElement("div");
    document.body.append(host);
    return { host, root: createRoot(host), onCursor: vi.fn(), onPlay: vi.fn() };
  })();
  live = harness;
  act(() => { harness.root.render(createElement(Timeline, { events, playing, cursor, onCursor: harness.onCursor, onPlay: harness.onPlay })); });
  return harness;
}

afterEach(() => {
  if (live) act(() => { live!.root.unmount(); });
  live?.host.remove();
  live = undefined;
  vi.useRealTimers();
});

const slider = (host: HTMLElement): HTMLInputElement => host.querySelector("input[type=range]")!;
const reviewButton = (host: HTMLElement): HTMLButtonElement => host.querySelectorAll<HTMLButtonElement>(".timeline-mode button")[1]!;
const playButton = (host: HTMLElement): HTMLButtonElement => host.querySelector<HTMLButtonElement>(".play-button")!;

describe("timeline controls", () => {
  it("gives a one-event window exactly one position", () => {
    // A floor of 1 put the cursor past the end of the log it indexes: the slider parked at 1/1 and the
    // foot read "— / REPLAY" because events[1] does not exist.
    const { host, onCursor } = show([event(1)], undefined);
    expect(slider(host).max).toBe("0");
    expect(slider(host).value).toBe("0");
    act(() => { reviewButton(host).click(); });
    expect(onCursor).toHaveBeenCalledWith(0);
    expect(host.querySelector(".timeline-foot .mono")?.textContent).toBe("NOW / FOLLOWING");
  });

  it("refuses review and replay while the window is empty", () => {
    // Entering REVIEW before the first event froze the log on whatever delta arrived first and held the
    // dashboard on that one event while the stream filled.
    const { host } = show([], undefined);
    expect(reviewButton(host).disabled).toBe(true);
    expect(playButton(host).disabled).toBe(true);
  });

  it("starts the replay when play is pressed in live", () => {
    vi.useFakeTimers();
    // In LIVE there is no cursor to advance: re-setting `undefined` was a no-op, so the button flipped
    // to Pause and the interval spun forever without ever entering replay.
    const { host, onCursor, onPlay } = show([event(1), event(2), event(3)], undefined, true);
    act(() => { vi.advanceTimersByTime(900); });
    expect(onCursor).toHaveBeenLastCalledWith(0);

    show([event(1), event(2), event(3)], 0, true);
    act(() => { vi.advanceTimersByTime(900); });
    expect(onCursor).toHaveBeenLastCalledWith(1);

    // The end of the window returns to LIVE and stops, instead of looping the replay forever.
    show([event(1), event(2), event(3)], 2, true);
    act(() => { vi.advanceTimersByTime(900); });
    expect(onCursor).toHaveBeenLastCalledWith(undefined);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(host.isConnected).toBe(true);
  });
});

describe("scope filters", () => {
  const base: Filters = { instance: "", persona: "", channel: "all", attention: "all" };

  it("clears a selection whose option is gone and leaves a live one alone", () => {
    const gone = reconcileFilters({ ...base, instance: "pi-persona::beta", persona: "reviewer" }, { "pi-persona::alpha": {} }, ["operator"]);
    expect(gone.instance).toBe("");
    expect(gone.persona).toBe("");

    const kept: Filters = { ...base, instance: "pi-persona::alpha", persona: "operator" };
    expect(reconcileFilters(kept, { "pi-persona::alpha": {} }, ["operator"])).toBe(kept);
  });
});
