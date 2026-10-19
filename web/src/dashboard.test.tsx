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
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close(): void { this.closed = true; }
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
