// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/background/settings.ts";

vi.mock("$lib/api", () => ({
  getState: vi.fn(),
  toggleSite: vi.fn(async () => {}),
  setGlobal: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({ schema: 1, enabled: true, substitute: false, disabledSites: [], allowedSites: [] })),
  getStats: vi.fn(),
  getLibraries: vi.fn(),
  exportConfig: vi.fn(async () => "{}"),
  importConfig: vi.fn(async () => {}),
  openOptions: vi.fn(async () => {}),
}));
const api = await import("$lib/api");
const { default: Popup } = await import("../src/popup/App.svelte");
const { default: Stats } = await import("../src/options/pages/Stats.svelte");
const { default: Libraries } = await import("../src/options/pages/Libraries.svelte");

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal("chrome", { storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("popup", () => {
  it("shows the current host and its count, and the switch calls toggleSite", async () => {
    vi.mocked(api.getState).mockResolvedValue({ settings: DEFAULT_SETTINGS, tab: { host: "example.com", count: 3 } });
    render(Popup);
    expect(await screen.findByText("example.com")).toBeTruthy();
    expect(screen.getByText(/3/)).toBeTruthy();
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await fireEvent.click(sw);
    expect(api.toggleSite).toHaveBeenCalledWith("example.com", false);
  });

  it("reflects a disabled site and offers to enable it", async () => {
    vi.mocked(api.getState).mockResolvedValue({
      settings: { ...DEFAULT_SETTINGS, disabledSites: ["example.com"] },
      tab: { host: "example.com", count: 0 },
    });
    render(Popup);
    const sw = await screen.findByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await fireEvent.click(sw);
    expect(api.toggleSite).toHaveBeenCalledWith("example.com", true);
  });

  it("disables the switch on pages that are not http(s)", async () => {
    vi.mocked(api.getState).mockResolvedValue({ settings: DEFAULT_SETTINGS, tab: { host: "", count: 0 } });
    render(Popup);
    const sw = await screen.findByRole("switch");
    expect(sw.hasAttribute("disabled") || sw.getAttribute("data-disabled") !== null).toBe(true);
  });

  it("opens the options page", async () => {
    vi.mocked(api.getState).mockResolvedValue({ settings: DEFAULT_SETTINGS, tab: { host: "a.com", count: 0 } });
    render(Popup);
    await fireEvent.click(await screen.findByRole("button", { name: /options/i }));
    expect(api.openOptions).toHaveBeenCalled();
  });
});

describe("options stats page", () => {
  it("renders the total and per-library counts", async () => {
    vi.mocked(api.getStats).mockResolvedValue({ total: 12, byLibrary: { jquery: 9, bootstrap: 3 } });
    render(Stats);
    expect(await screen.findByText("12")).toBeTruthy();
    expect(screen.getByText("jquery")).toBeTruthy();
    expect(screen.getByText("bootstrap")).toBeTruthy();
    expect(api.getStats).toHaveBeenCalledWith("week");
  });

  it("reloads when the range changes", async () => {
    vi.mocked(api.getStats).mockResolvedValue({ total: 1, byLibrary: {} });
    render(Stats);
    await screen.findByText("1");
    await fireEvent.click(screen.getByRole("tab", { name: /month/i }));
    await waitFor(() => expect(api.getStats).toHaveBeenCalledWith("month"));
  });
});

describe("options libraries page", () => {
  const lib = (name: string) => ({
    name,
    npm: name,
    license: "MIT",
    versions: [{ version: "1.0.0", files: [{ path: "a.js", type: "script" as const, sha256: "0".repeat(64) }] }],
    patterns: [],
  });

  it("debounces the filter", async () => {
    vi.mocked(api.getLibraries).mockResolvedValue([lib("jquery"), lib("bootstrap")]);
    render(Libraries);
    await screen.findByText("jquery");
    vi.useFakeTimers();
    const input = screen.getByRole("searchbox");
    await fireEvent.input(input, { target: { value: "boot" } });
    expect(screen.queryByText("jquery")).toBeTruthy(); // not applied yet
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(screen.queryByText("jquery")).toBeNull());
    expect(screen.getByText("bootstrap")).toBeTruthy();
  });
});
