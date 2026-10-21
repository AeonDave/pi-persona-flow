/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEvent } from "../../shared/protocol";
import type { WorkspaceCatalog } from "../../shared/workspaces";
import { createGraphState, reduceTelemetry } from "../../src/reducer";
import { useDashboard } from "./state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response;
}

function started(name: string): TelemetryEvent {
  return {
    version: 2, producerId: "pi-persona", producerVersion: "1.10.5", id: `started-${name}`, seq: 1,
    ts: 1000, sessionId: "shared-session-id", workspaceId: "0123456789abcdef01234567",
    type: "instance.started", payload: { displayName: name, status: "active" },
  } as unknown as TelemetryEvent;
}

function snapshot(name: string): { cursor: number; state: ReturnType<typeof createGraphState> } {
  return { cursor: 1, state: reduceTelemetry(createGraphState(), started(name)) };
}

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  closed = false;
  readyState: number = FakeEventSource.CONNECTING;
  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close(): void { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
  fail(readyState: number): void { this.readyState = readyState; this.onerror?.(new Event("error")); }
  emit(type: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const catalog: WorkspaceCatalog = {
  defaultWorkspaceId: "workspace-a",
  workspaces: [
    { id: "workspace-a", label: "alpha", activeSessions: 1, lastSeenAt: 1000 },
    { id: "workspace-b", label: "beta", activeSessions: 1, lastSeenAt: 2000 },
  ],
};

let root: Root | undefined;
let host: HTMLElement | undefined;
let oldUrl = "";

function mountDashboard(): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Harness() {
    const dashboard = useDashboard();
    const instance = dashboard.graph.instances["pi-persona::shared-session-id"];
    return createElement("div", null,
      createElement("span", { "data-testid": "workspace" }, dashboard.selectedWorkspaceId),
      createElement("span", { "data-testid": "catalog" }, dashboard.workspaces.map((workspace) => workspace.id).join(",")),
      createElement("span", { "data-testid": "instance" }, instance?.displayName ?? "empty"),
      createElement("span", { "data-testid": "connection" }, dashboard.connection),
      createElement("span", { "data-testid": "error" }, dashboard.error ?? ""),
      createElement("button", { onClick: () => dashboard.selectWorkspace("workspace-b") }, "select beta"),
    );
  }
  act(() => { root!.render(createElement(Harness)); });
  return host;
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => {
  if (root) act(() => { root!.unmount(); });
  host?.remove();
  root = undefined;
  host = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (oldUrl) window.history.replaceState(null, "", oldUrl);
  oldUrl = "";
  FakeEventSource.instances = [];
});

describe("workspace-scoped dashboard connection", () => {
  it("automatically reboots a terminally closed stream and ignores all callbacks from its replaced source", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let snapshotRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/workspaces")) return Promise.resolve(response(catalog));
      snapshotRequests += 1;
      return Promise.resolve(response({ ...snapshot(snapshotRequests === 1 ? "Before" : "Recovered"), streamEpoch: `daemon-${snapshotRequests}` }));
    }));
    const content = mountDashboard();
    await flush();
    const failed = FakeEventSource.instances[0]!;
    act(() => { failed.fail(FakeEventSource.CLOSED); });
    expect(content.querySelector('[data-testid="connection"]')?.textContent).toBe("offline");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(snapshotRequests).toBe(2);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(failed.closed).toBe(true);
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Recovered");
    const recovered = FakeEventSource.instances[1]!;
    const url = new URL(recovered.url, window.location.origin);
    expect(url.searchParams.get("streamEpoch")).toBe("daemon-2");
    act(() => {
      recovered.readyState = FakeEventSource.OPEN;
      recovered.onopen?.(new Event("open"));
      failed.onopen?.(new Event("open"));
      failed.emit("telemetry", { cursor: 99, event: { ...started("Late delta"), id: "late-delta", seq: 99 } });
      failed.emit("snapshot", snapshot("Late snapshot"));
      failed.fail(FakeEventSource.CLOSED);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(snapshotRequests).toBe(2);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Recovered");
    expect(content.querySelector('[data-testid="connection"]')?.textContent).toBe("live");
  });

  it("retains native stream retries while EventSource is still connecting", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let snapshotRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/workspaces")) return Promise.resolve(response(catalog));
      snapshotRequests += 1;
      return Promise.resolve(response(snapshot("Native retry")));
    }));
    const content = mountDashboard();
    await flush();
    const source = FakeEventSource.instances[0]!;
    act(() => { source.fail(FakeEventSource.CONNECTING); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(snapshotRequests).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.closed).toBe(false);
    act(() => { source.readyState = FakeEventSource.OPEN; source.onopen?.(new Event("open")); });
    expect(content.querySelector('[data-testid="connection"]')?.textContent).toBe("live");
  });

  it.each(["switch", "unmount"])("cancels terminal-stream rebootstrap on %s", async (action) => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let alphaRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/workspaces") return Promise.resolve(response(catalog));
      if (url.searchParams.get("workspace") === "workspace-b") return Promise.resolve(response(snapshot("Beta")));
      alphaRequests += 1;
      return Promise.resolve(response(snapshot("Alpha")));
    }));
    const content = mountDashboard();
    await flush();
    act(() => { FakeEventSource.instances[0]!.fail(FakeEventSource.CLOSED); });
    if (action === "switch") act(() => { (content.querySelector("button") as HTMLButtonElement).click(); });
    else { act(() => { root!.unmount(); }); root = undefined; }
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(alphaRequests).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(action === "switch" ? 2 : 1);
    if (action === "switch") expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Beta");
  });

  it("stops terminal-stream recovery when the fresh snapshot rejects authorization", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let snapshotRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/workspaces")) return Promise.resolve(response(catalog));
      snapshotRequests += 1;
      return Promise.resolve(snapshotRequests === 1 ? response(snapshot("Before auth failure")) : { ok: false, status: 401 } as Response);
    }));
    const content = mountDashboard();
    await flush();
    act(() => { FakeEventSource.instances[0]!.fail(FakeEventSource.CLOSED); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(snapshotRequests).toBe(2);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(content.querySelector('[data-testid="error"]')?.textContent).toContain("Not authorized");
  });

  it("bounds a hung initial workspace catalog and recovers on the existing refresh loop", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let catalogRequests = 0;
    let snapshotRequests = 0;
    let firstSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/snapshot")) {
        snapshotRequests += 1;
        return Promise.resolve(response(snapshot("Recovered catalog")));
      }
      catalogRequests += 1;
      if (catalogRequests !== 1) return Promise.resolve(response(catalog));
      firstSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        firstSignal?.addEventListener("abort", () => reject(new DOMException("Request aborted", "AbortError")), { once: true });
      });
    }));
    const content = mountDashboard();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(catalogRequests).toBe(1);
    expect(snapshotRequests).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(catalogRequests).toBeGreaterThanOrEqual(2);
    expect(catalogRequests).toBeLessThanOrEqual(3);
    expect(snapshotRequests).toBe(1);
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Recovered catalog");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("cancels a hung catalog request and its deadline on unmount", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener("abort", () => reject(new DOMException("Request aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    mountDashboard();
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => { root!.unmount(); });
    root = undefined;
    await flush();
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it.each([503, 404, 429])("automatically retries an initial snapshot outage and HTTP %s before opening its stream", async (status) => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let snapshotRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/workspaces") return Promise.resolve(response(catalog));
      snapshotRequests += 1;
      if (snapshotRequests === 1) return Promise.reject(new TypeError("Failed to fetch"));
      if (snapshotRequests === 2) return Promise.resolve({ ok: false, status } as Response);
      return Promise.resolve(response({ ...snapshot("Recovered"), streamEpoch: "new-daemon-epoch" }));
    }));

    const content = mountDashboard();
    await flush();
    expect(snapshotRequests).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(content.querySelector('[data-testid="connection"]')?.textContent).toBe("offline");
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(snapshotRequests).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(snapshotRequests).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(snapshotRequests).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(snapshotRequests).toBe(3);
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Recovered");
    expect(FakeEventSource.instances).toHaveLength(1);
    const streamUrl = new URL(FakeEventSource.instances[0]!.url, window.location.origin);
    expect(streamUrl.searchParams.get("token")).toBe("test-token");
    expect(streamUrl.searchParams.get("streamEpoch")).toBe("new-daemon-epoch");
  });

  it("caps repeated snapshot outage delays at thirty seconds", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let snapshotRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/workspaces")) return Promise.resolve(response(catalog));
      snapshotRequests += 1;
      return Promise.reject(new TypeError("Failed to fetch"));
    }));
    mountDashboard();
    await flush();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const previous = snapshotRequests;
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
      expect(snapshotRequests).toBe(previous);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(snapshotRequests).toBe(previous + 1);
    }
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("passes the snapshot epoch to the initial stream and accepts an authoritative restart snapshot", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve(response(
      String(input).startsWith("/api/workspaces") ? catalog : { ...snapshot("Before restart"), streamEpoch: "first-daemon" },
    ))));
    const content = mountDashboard();
    await flush();
    const source = FakeEventSource.instances[0]!;
    const url = new URL(source.url, window.location.origin);
    expect(url.searchParams.get("after")).toBe("1");
    expect(url.searchParams.get("streamEpoch")).toBe("first-daemon");
    act(() => { source.emit("snapshot", { cursor: 0, state: createGraphState(), streamEpoch: "replacement-daemon" }); });
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("empty");
    act(() => { source.emit("telemetry", { cursor: 1, event: { ...started("After restart"), id: "restart-event" } }); });
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("After restart");
  });

  it("bounds a hung initial snapshot and retries it automatically", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let snapshotRequests = 0;
    let firstSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/workspaces")) return Promise.resolve(response(catalog));
      snapshotRequests += 1;
      if (snapshotRequests !== 1) return Promise.resolve(response(snapshot("Recovered after timeout")));
      firstSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        firstSignal?.addEventListener("abort", () => reject(new DOMException("Request aborted", "AbortError")), { once: true });
      });
    }));
    const content = mountDashboard();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(firstSignal?.aborted).toBe(true);
    expect(snapshotRequests).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(snapshotRequests).toBe(2);
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Recovered after timeout");
  });

  it.each([401, 403])("keeps authorization failures terminal without retrying HTTP %s", async (status) => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let snapshotRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/workspaces")) return Promise.resolve(response(catalog));
      snapshotRequests += 1;
      return Promise.resolve({ ok: false, status } as Response);
    }));
    const content = mountDashboard();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(snapshotRequests).toBe(1);
    expect(content.querySelector('[data-testid="error"]')?.textContent).toContain("Not authorized");
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it.each(["switch", "unmount"])("cancels a pending outage retry on %s", async (action) => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let alphaRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/workspaces") return Promise.resolve(response(catalog));
      if (url.searchParams.get("workspace") === "workspace-b") return Promise.resolve(response(snapshot("Beta")));
      alphaRequests += 1;
      return Promise.reject(new TypeError("Failed to fetch"));
    }));
    const content = mountDashboard();
    await flush();
    if (action === "switch") act(() => { (content.querySelector("button") as HTMLButtonElement).click(); });
    else { act(() => { root!.unmount(); }); root = undefined; }
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(alphaRequests).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(action === "switch" ? 1 : 0);
    if (action === "switch") expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Beta");
  });

  it("aborts a late snapshot and never opens or applies the old workspace stream after switching", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a#view");
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const lateAlpha = deferred<Response>();
    const requested: Array<{ url: URL; signal?: AbortSignal }> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      requested.push({ url, signal: init?.signal ?? undefined });
      if (url.pathname === "/api/workspaces") return Promise.resolve(response(catalog));
      if (url.pathname === "/api/snapshot" && url.searchParams.get("workspace") === "workspace-a") return lateAlpha.promise;
      if (url.pathname === "/api/snapshot" && url.searchParams.get("workspace") === "workspace-b") return Promise.resolve(response(snapshot("Beta same IDs")));
      throw new Error(`Unexpected request ${url}`);
    }));

    const content = mountDashboard();
    await flush();
    expect(content.querySelector('[data-testid="workspace"]')?.textContent).toBe("workspace-a");
    expect(requested.some(({ url }) => url.pathname === "/api/snapshot" && url.searchParams.get("workspace") === "workspace-a")).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(0);

    act(() => { (content.querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    expect(window.location.search).toContain("workspace=workspace-b");
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Beta same IDs");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toContain("workspace=workspace-b");
    expect(requested.find(({ url }) => url.pathname === "/api/snapshot" && url.searchParams.get("workspace") === "workspace-a")?.signal?.aborted).toBe(true);

    await act(async () => { lateAlpha.resolve(response(snapshot("Late Alpha"))); await Promise.resolve(); await Promise.resolve(); });
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Beta same IDs");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("closes the old workspace stream and ignores its late telemetry even when entity IDs collide", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-a");
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/workspaces") return Promise.resolve(response(catalog));
      if (url.pathname === "/api/snapshot" && url.searchParams.get("workspace") === "workspace-a") return Promise.resolve(response(snapshot("Alpha")));
      if (url.pathname === "/api/snapshot" && url.searchParams.get("workspace") === "workspace-b") return Promise.resolve(response(snapshot("Beta")));
      throw new Error(`Unexpected request ${url}`);
    }));

    const content = mountDashboard();
    await flush();
    const alphaSource = FakeEventSource.instances[0];
    expect(alphaSource?.url).toContain("workspace=workspace-a");
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Alpha");

    act(() => { (content.querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    expect(alphaSource?.closed).toBe(true);
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Beta");

    const lateAlphaEvent: TelemetryEvent = {
      ...started("late Alpha"), id: "late-alpha", seq: 2, type: "instance.started",
    } as unknown as TelemetryEvent;
    await act(async () => {
      alphaSource?.emit("telemetry", { cursor: 2, event: lateAlphaEvent });
      await Promise.resolve();
    });
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Beta");
    expect(FakeEventSource.instances.map((source) => new URL(source.url, window.location.origin).searchParams.get("workspace"))).toEqual(["workspace-a", "workspace-b"]);
  });

  it("falls back when the selected workspace disappears from the refreshed catalog", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=workspace-b");
    FakeEventSource.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    let currentCatalog = catalog;
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/workspaces") return Promise.resolve(response(currentCatalog));
      if (url.pathname === "/api/snapshot") {
        const workspaceId = url.searchParams.get("workspace");
        return Promise.resolve(response(snapshot(workspaceId === "workspace-b" ? "Beta" : "Alpha")));
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const content = mountDashboard();
    await flush();
    expect(content.querySelector('[data-testid="workspace"]')?.textContent).toBe("workspace-b");
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Beta");

    currentCatalog = { defaultWorkspaceId: "workspace-a", workspaces: [catalog.workspaces[0]!] };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await flush();
    expect(content.querySelector('[data-testid="workspace"]')?.textContent).toBe("workspace-a");
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("Alpha");
    expect(new URL(window.location.href).searchParams.get("workspace")).toBe("workspace-a");
    expect(new URL(window.location.href).searchParams.get("token")).toBe("test-token");
  });

  it("does not substitute a default workspace for an explicit unknown URL selection", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token&workspace=missing-workspace");
    vi.stubGlobal("EventSource", FakeEventSource);
    const requestedSnapshots: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/workspaces") return Promise.resolve(response(catalog));
      if (url.pathname === "/api/snapshot") {
        requestedSnapshots.push(url.searchParams.get("workspace") ?? "");
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    const content = mountDashboard();
    await flush();
    expect(content.querySelector('[data-testid="workspace"]')?.textContent).toBe("missing-workspace");
    expect(requestedSnapshots).toEqual(["missing-workspace"]);
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("empty");
  });

  it("clears the graph and stays offline without snapshot retries when the catalog is empty", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token");
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const snapshotRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/workspaces") return Promise.resolve(response({ workspaces: [] }));
      if (url.pathname === "/api/snapshot") snapshotRequests.push(url.pathname);
      throw new Error(`Unexpected request ${url}`);
    }));

    const content = mountDashboard();
    await flush();
    expect(content.querySelector('[data-testid="workspace"]')?.textContent).toBe("");
    expect(content.querySelector('[data-testid="instance"]')?.textContent).toBe("empty");
    expect(snapshotRequests).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(snapshotRequests).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("refreshes the catalog while open and applies a new workspace without reloading", async () => {
    oldUrl = window.location.href;
    window.history.replaceState(null, "", "/?token=test-token");
    FakeEventSource.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const expandedCatalog: WorkspaceCatalog = {
      ...catalog,
      workspaces: [...catalog.workspaces, { id: "workspace-c", label: "gamma", activeSessions: 2, lastSeenAt: 3000 }],
    };
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/workspaces") return Promise.resolve(response(fetcher.mock.calls.length > 1 ? expandedCatalog : catalog));
      if (url.pathname === "/api/snapshot") return Promise.resolve(response(snapshot("Live")));
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const content = mountDashboard();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(content.querySelector('[data-testid="catalog"]')?.textContent).toBe("workspace-a,workspace-b,workspace-c");
    expect(window.location.search).toContain("token=test-token");
    expect(window.location.search).toContain("workspace=workspace-a");
  });
});
