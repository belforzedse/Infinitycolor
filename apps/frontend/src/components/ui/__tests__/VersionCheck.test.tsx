import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VersionCheck from "../VersionCheck";
import {
  VERSION_RELOAD_QUERY,
  VERSION_RELOAD_STORAGE_KEY,
  VERSION_RELOAD_SUPPRESS_MS,
  buildCacheBustingReloadUrl,
  parseVersionReloadAttempt,
  shouldHideStaleBanner,
  stripCacheBustingReloadParam,
} from "../version-check";

jest.mock("@/constants/build", () => ({
  BUILD_VERSION: "old-build",
  default: "old-build",
}));

const CLIENT_VERSION = "old-build";
const SERVER_VERSION = "new-build";

function jsonResponse(version: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      BUILD_VERSION: version,
      timestamp: 1,
      commitHash: "abc",
      generatedAt: "2026-09-17T00:00:00.000Z",
    }),
  };
}

describe("version-check helpers", () => {
  it("adds a unique query so shared HTML caches miss", () => {
    expect(buildCacheBustingReloadUrl("https://infinitycolor.co/", "abc-1")).toBe(
      `https://infinitycolor.co/?${VERSION_RELOAD_QUERY}=abc-1`,
    );
    expect(buildCacheBustingReloadUrl("https://infinitycolor.co/plp?sort=new", "abc-1")).toBe(
      `https://infinitycolor.co/plp?sort=new&${VERSION_RELOAD_QUERY}=abc-1`,
    );
  });

  it("strips the reload query without dropping other params", () => {
    expect(
      stripCacheBustingReloadParam(
        `https://infinitycolor.co/plp?sort=new&${VERSION_RELOAD_QUERY}=abc-1`,
      ),
    ).toBe("/plp?sort=new");
  });

  it("hides the banner only for a recent attempt of the same origin version", () => {
    const now = 1_000_000;
    expect(shouldHideStaleBanner("new", null, now)).toBe(false);
    expect(shouldHideStaleBanner("new", { version: "old", at: now }, now)).toBe(false);
    expect(shouldHideStaleBanner("new", { version: "new", at: now - 1000 }, now)).toBe(true);
    expect(
      shouldHideStaleBanner("new", { version: "new", at: now - VERSION_RELOAD_SUPPRESS_MS }, now),
    ).toBe(false);
  });

  it("rejects malformed reload-attempt payloads", () => {
    expect(parseVersionReloadAttempt(null)).toBeNull();
    expect(parseVersionReloadAttempt("{")).toBeNull();
    expect(parseVersionReloadAttempt(JSON.stringify({ version: "", at: 1 }))).toBeNull();
    expect(parseVersionReloadAttempt(JSON.stringify({ version: "a", at: 2 }))).toEqual({
      version: "a",
      at: 2,
    });
  });
});

describe("VersionCheck", () => {
  const originalFetch = global.fetch;
  const NAVIGATION_NOT_IMPLEMENTED = "Not implemented: navigation";

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(SERVER_VERSION));
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("shows the banner when the origin version and the loaded JS disagree", async () => {
    render(<VersionCheck />);
    expect(await screen.findByTestId("version-check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "به‌روزرسانی" })).toBeInTheDocument();
  });

  it("does not show the banner when versions already match", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(CLIENT_VERSION));
    render(<VersionCheck />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("version-check")).not.toBeInTheDocument();
  });

  it("does not nag again after the visitor already reloaded for this origin version", async () => {
    sessionStorage.setItem(
      VERSION_RELOAD_STORAGE_KEY,
      JSON.stringify({ version: SERVER_VERSION, at: Date.now() }),
    );
    render(<VersionCheck />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("version-check")).not.toBeInTheDocument();
  });

  it("records the origin version and navigates instead of reloading the same URL", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    render(<VersionCheck />);
    const button = await screen.findByRole("button", { name: "به‌روزرسانی" });
    await userEvent.click(button);

    await waitFor(() => {
      const stored = parseVersionReloadAttempt(sessionStorage.getItem(VERSION_RELOAD_STORAGE_KEY));
      expect(stored?.version).toBe(SERVER_VERSION);
    });
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((arg) => String(arg).includes(NAVIGATION_NOT_IMPLEMENTED)),
      ),
    ).toBe(true);
    consoleError.mockRestore();
  });
});
