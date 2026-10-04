import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import AuthInitializer from "./AuthInitializer";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { centralAuth } from "@/lib/central-auth";
import type { MeResponse } from "@/types/user-me";
import UserService from "@/services/user";

let version = 0;
let listener: (event: { type: string }) => void;
jest.mock("@/lib/central-auth", () => ({
  centralAuthOrigin: "https://auth.test",
  centralAuth: { tokenManager: { getTokenOutcome: jest.fn() } },
  initializeCentralAuthBrowser: jest.fn(),
  readAuthStateVersion: () => version,
  subscribeToAuthState: jest.fn((callback) => {
    listener = callback;
    return jest.fn();
  }),
}));
jest.mock("@/services/user", () => ({
  __esModule: true,
  default: { me: jest.fn() },
}));
jest.mock("@/lib/diagnostic-log", () => ({ logDiagnostic: jest.fn() }));
const user = { id: 7, isAdmin: true } as MeResponse;
const token = jest.mocked(centralAuth.tokenManager.getTokenOutcome);
const me = jest.mocked(UserService.me);
beforeEach(() => {
  version = 0;
  jest.clearAllMocks();
  token.mockResolvedValue({ state: "authenticated", token: "jwt" });
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
});
function mount() {
  const store = createStore();
  store.set(currentUserAtom, user);
  const view = render(
    <Provider store={store}>
      <AuthInitializer />
    </Provider>,
  );
  return { store, ...view };
}
it("preserves identity during temporary token failures", async () => {
  token.mockResolvedValue({ state: "unavailable", reasonCode: "timeout" });
  const { store } = mount();
  await waitFor(() => expect(store.get(userLoadingAtom)).toBe(false));
  expect(store.get(currentUserAtom)).toBe(user);
  expect(me).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves identity on 403 and clears it only after confirmed central 401", async () => {
  me.mockRejectedValueOnce({ status: 403 });
  const { store, unmount } = mount();
  await waitFor(() => expect(store.get(userLoadingAtom)).toBe(false));
  expect(store.get(currentUserAtom)).toBe(user);
  expect(token).toHaveBeenCalledTimes(1);
  unmount();
  me.mockRejectedValueOnce({ status: 401 });
  token
    .mockResolvedValueOnce({ state: "authenticated", token: "jwt" })
    .mockResolvedValueOnce({ state: "unauthenticated" });
  const next = mount();
  await waitFor(() => expect(next.store.get(userLoadingAtom)).toBe(false));
  expect(next.store.get(currentUserAtom)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("discards profiles that arrive after logout", async () => {
  let resolve!: (value: typeof user) => void;
  me.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { store } = mount();
  await waitFor(() => expect(me).toHaveBeenCalled());
  act(() => {
    version += 1;
    listener({ type: "logout" });
  });
  await act(async () => resolve(user));
  expect(store.get(currentUserAtom)).toBeNull();
  expect(store.get(userLoadingAtom)).toBe(false);
});
it("never displays the old account while a changed session is temporarily unavailable", async () => {
  me.mockResolvedValue(user);
  const { store } = mount();
  await waitFor(() => expect(store.get(userLoadingAtom)).toBe(false));
  token.mockResolvedValueOnce({ state: "unavailable", reasonCode: "network" });
  act(() => {
    version += 1;
    listener({ type: "session_changed" });
  });
  await waitFor(() => expect(store.get(userLoadingAtom)).toBe(false));
  expect(store.get(currentUserAtom)).toBeNull();
});
