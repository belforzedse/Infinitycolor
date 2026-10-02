import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import type { MeResponse } from "../../../services/user/me";
import jotaiStore from "../../../lib/jotaiStore";
import { currentUserAtom } from "../../../lib/atoms/auth";
import { AUTH_STATE_EVENT } from "@repo/auth-core/contracts";

jest.mock("../../../services/user", () => ({
  __esModule: true,
  default: {
    me: jest.fn(),
  },
}));

jest.mock("../../../lib/central-auth", () => ({
  centralAuthOrigin: "http://localhost:2889",
  readAuthStateVersion: jest.fn(() => 0),
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
      getTokenOutcome: jest.fn(async (options: unknown) => {
        try {
          const token = await (
            jest.requireMock("../../../lib/central-auth") as {
              centralAuth: {
                tokenManager: { getToken: (options: unknown) => Promise<string | null> };
              };
            }
          ).centralAuth.tokenManager.getToken(options);
          return token ? { state: "authenticated", token } : { state: "unauthenticated" };
        } catch (error) {
          return { state: "unavailable", reasonCode: "network" };
        }
      }),
      expire: jest.fn(),
    },
  },
  initializeCentralAuthBrowser: jest.fn(),
  subscribeToAuthState: jest.fn((listener: (event: { type: string; at: number }) => void) => {
    const handler = (event: Event) => listener((event as CustomEvent).detail);
    window.addEventListener(AUTH_STATE_EVENT, handler);
    return () => window.removeEventListener(AUTH_STATE_EVENT, handler);
  }),
}));

const AuthInitializer = require("../AuthInitializer")
  .default as typeof import("../AuthInitializer").default;
const UserService = require("../../../services/user")
  .default as typeof import("../../../services/user").default;
const mockedMe = UserService.me as jest.MockedFunction<typeof UserService.me>;
const mockedCentralAuth = jest.requireMock("../../../lib/central-auth") as {
  centralAuth: { tokenManager: { getToken: jest.Mock; expire: jest.Mock } };
};

const buildUser = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  Bio: null,
  BirthDate: null,
  FirstName: "Test",
  IsActive: true,
  IsVerified: true,
  LastName: "User",
  NationalCode: null,
  Phone: "09120000000",
  Sex: null,
  createdAt: new Date().toISOString(),
  id: overrides.id ?? 1,
  updatedAt: new Date().toISOString(),
  isAdmin: overrides.isAdmin,
  UserName: overrides.UserName,
  roleName: overrides.roleName ?? null,
  ...overrides,
});

describe("AuthInitializer", () => {
  beforeEach(() => {
    mockedMe.mockReset();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue("jwt");
    mockedCentralAuth.centralAuth.tokenManager.expire.mockReset();
    localStorage.clear();
    jotaiStore.set(currentUserAtom, null);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 204 } as Response) as jest.MockedFunction<
      typeof fetch
    >;
  });

  it("preserves known identity when token acquisition is temporarily unavailable", async () => {
    const user = buildUser();
    jotaiStore.set(currentUserAtom, user);
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockRejectedValueOnce(
      new Error("network unavailable"),
    );
    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });
    expect(jotaiStore.get(currentUserAtom)).toEqual(user);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockedMe).not.toHaveBeenCalled();
  });

  it("does not restore a delayed profile after logout", async () => {
    let resolve!: (value: MeResponse) => void;
    mockedMe.mockImplementationOnce(
      () =>
        new Promise<MeResponse>((r) => {
          resolve = r;
        }),
    );
    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });
    act(() =>
      window.dispatchEvent(
        new CustomEvent(AUTH_STATE_EVENT, { detail: { type: "logout", at: Date.now() } }),
      ),
    );
    await act(async () => resolve(buildUser()));
    expect(jotaiStore.get(currentUserAtom)).toBeNull();
  });

  it("clears a stale route hint when no central session exists", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValueOnce(null);

    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/auth/route-hint",
        expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
      );
    });
    expect(mockedMe).not.toHaveBeenCalled();
  });

  it("refreshes user data when logging out and logging in as another role", async () => {
    mockedMe.mockResolvedValueOnce(
      buildUser({
        id: 1,
        roleName: "Store manager",
      }),
    );

    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });

    await waitFor(() => {
      expect(jotaiStore.get(currentUserAtom)?.roleName).toBe("Store manager");
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AUTH_STATE_EVENT, { detail: { type: "logout", at: Date.now() } }),
      );
    });

    await waitFor(() => {
      expect(jotaiStore.get(currentUserAtom)).toBeNull();
    });

    mockedMe.mockResolvedValueOnce(
      buildUser({
        id: 2,
        roleName: "SuperAdmin",
        isAdmin: true,
      }),
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AUTH_STATE_EVENT, {
          detail: { type: "session-changed", at: Date.now() },
        }),
      );
    });

    await waitFor(() => {
      expect(jotaiStore.get(currentUserAtom)?.roleName).toBe("SuperAdmin");
    });
  });

  it("preserves identity and route hints during a temporary API failure", async () => {
    const existing = buildUser({ id: 17, roleName: "SuperAdmin", isAdmin: true });
    jotaiStore.set(currentUserAtom, existing);
    mockedMe.mockRejectedValueOnce({ status: 503, message: "temporarily unavailable" });

    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });

    await waitFor(() => expect(mockedMe).toHaveBeenCalledTimes(1));
    expect(jotaiStore.get(currentUserAtom)).toEqual(existing);
    expect(mockedCentralAuth.centralAuth.tokenManager.expire).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("drops a session that died elsewhere when the tab regains focus", async () => {
    // A password reset happens on the central auth origin and publishes no event here, so
    // without this the tab kept rendering the account UI with a stale identity.
    mockedMe.mockResolvedValueOnce(buildUser({ id: 1 }));

    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });
    await waitFor(() => expect(jotaiStore.get(currentUserAtom)).not.toBeNull());

    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(null);
    // The check is throttled, and mounting counts as the most recent one.
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(jotaiStore.get(currentUserAtom)).toBeNull());
    nowSpy.mockRestore();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/route-hint",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });

  it("keeps the identity when the session is still alive on focus", async () => {
    mockedMe.mockResolvedValueOnce(buildUser({ id: 1 }));

    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });
    await waitFor(() => expect(jotaiStore.get(currentUserAtom)).not.toBeNull());

    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    nowSpy.mockRestore();

    expect(jotaiStore.get(currentUserAtom)).not.toBeNull();
  });

  it("throttles the focus check so a tab-switch storm cannot mint tokens in a loop", async () => {
    mockedMe.mockResolvedValueOnce(buildUser({ id: 1 }));

    await act(async () => {
      render(
        <Provider store={jotaiStore}>
          <AuthInitializer />
        </Provider>,
      );
    });
    await waitFor(() => expect(jotaiStore.get(currentUserAtom)).not.toBeNull());

    const callsAfterMount = mockedCentralAuth.centralAuth.tokenManager.getToken.mock.calls.length;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(mockedCentralAuth.centralAuth.tokenManager.getToken).toHaveBeenCalledTimes(
      callsAfterMount,
    );
  });
  it.each([
    new TypeError("Failed to fetch"),
    new DOMException("timed out", "AbortError"),
    { status: 503 },
  ])("preserves identity on a failed focus check: %s", async (cause) => {
    const existing = buildUser({ id: 27 });
    mockedMe.mockResolvedValueOnce(existing);
    render(
      <Provider store={jotaiStore}>
        <AuthInitializer />
      </Provider>,
    );
    await waitFor(() => expect(jotaiStore.get(currentUserAtom)).toEqual(existing));
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockRejectedValueOnce(cause);
    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    clock.mockRestore();
    expect(jotaiStore.get(currentUserAtom)).toEqual(existing);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("discards a profile response that resolves after logout", async () => {
    let finish!: (value: MeResponse) => void;
    mockedMe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <Provider store={jotaiStore}>
        <AuthInitializer />
      </Provider>,
    );
    await waitFor(() => expect(mockedMe).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AUTH_STATE_EVENT, { detail: { type: "logout", at: Date.now() } }),
      );
    });
    await act(async () => {
      finish(buildUser({ id: 91 }));
    });
    expect(jotaiStore.get(currentUserAtom)).toBeNull();
  });
});
