import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider, createStore } from "jotai";
import { apiClient } from "@/services";
import { currentUserAtom } from "@/lib/atoms/auth";
import useProductLike, { likedProductsAtom, likedProductsOwnerAtom } from "../useProductLike";

// Mock the apiClient
jest.mock("@/services", () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

jest.mock("@/lib/central-auth", () => ({
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
    },
  },
  centralLoginUrl: jest.fn(() => "http://localhost:2889/auth"),
}));

const mockedCentralAuth = jest.requireMock("@/lib/central-auth") as {
  centralAuth: { tokenManager: { getToken: jest.Mock } };
};

const asUser = (id: number) => ({ id, isAdmin: false, roleName: "Customer" }) as any;

const like = (productId: number) => ({
  id: productId,
  product: { id: productId },
  createdAt: "2024-01-01",
  updatedAt: "2024-01-01",
});

describe("useProductLike", () => {
  const mockToken = "mock-token";

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset().mockResolvedValue(null);
    (apiClient.get as jest.Mock).mockResolvedValue({ data: [] });
    (apiClient.post as jest.Mock).mockResolvedValue({ isFavorite: true });
  });

  /**
   * Each render gets a fresh jotai store, so nothing leaks between tests through module
   * state — which is the point: the hook no longer keeps an immortal "already fetched"
   * flag, it keys everything on the authenticated identity in the store.
   */
  const renderUseProductLike = async (store = createStore(), productId = "123") => {
    let hookResult: ReturnType<typeof renderHook<any, any>>;

    await act(async () => {
      hookResult = renderHook(() => useProductLike({ productId }), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <Provider store={store}>{children}</Provider>
        ),
      });
    });

    return { hook: hookResult!, store };
  };

  it("should initialize with isLiked false", async () => {
    const { hook } = await renderUseProductLike();

    expect(hook.result.current.isLiked).toBe(false);
  });

  it("should fetch liked products on mount when authenticated", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    (apiClient.get as jest.Mock).mockResolvedValue({ data: [like(123)] });

    const store = createStore();
    store.set(currentUserAtom, asUser(1));
    const { hook } = await renderUseProductLike(store);

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(hook.result.current.isLiked).toBe(true);
    });
  });

  it("fetches once for a signed-in user even with several cards mounted", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    (apiClient.get as jest.Mock).mockResolvedValue({ data: [like(123)] });

    const store = createStore();
    store.set(currentUserAtom, asUser(1));

    await act(async () => {
      renderHook(
        () => {
          useProductLike({ productId: "123" });
          useProductLike({ productId: "456" });
          useProductLike({ productId: "789" });
        },
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <Provider store={store}>{children}</Provider>
          ),
        },
      );
    });

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledTimes(1);
    });
  });

  it("fetches after an anonymous mount is followed by login", async () => {
    // The regression this guards: a module-level `fetchStarted` flag used to be set
    // before the auth check, so the very first anonymous mount permanently suppressed
    // the fetch that should follow login.
    const store = createStore();
    const { hook } = await renderUseProductLike(store);

    expect(apiClient.get).not.toHaveBeenCalled();

    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    (apiClient.get as jest.Mock).mockResolvedValue({ data: [like(123)] });

    await act(async () => {
      store.set(currentUserAtom, asUser(1));
    });

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(hook.result.current.isLiked).toBe(true);
    });
  });

  it("clears the wishlist when the user logs out", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    (apiClient.get as jest.Mock).mockResolvedValue({ data: [like(123)] });

    const store = createStore();
    store.set(currentUserAtom, asUser(1));
    const { hook } = await renderUseProductLike(store);

    await waitFor(() => expect(hook.result.current.isLiked).toBe(true));

    await act(async () => {
      store.set(currentUserAtom, null);
    });

    await waitFor(() => {
      expect(hook.result.current.isLiked).toBe(false);
    });
    expect(store.get(likedProductsAtom)).toEqual([]);
    expect(store.get(likedProductsOwnerAtom)).toBeNull();
  });

  it("does not expose user A's likes to user B", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    (apiClient.get as jest.Mock).mockResolvedValue({ data: [like(123)] });

    const store = createStore();
    store.set(currentUserAtom, asUser(1));
    const { hook } = await renderUseProductLike(store);

    await waitFor(() => expect(hook.result.current.isLiked).toBe(true));

    // User B has liked something else entirely.
    (apiClient.get as jest.Mock).mockResolvedValue({ data: [like(999)] });
    await act(async () => {
      store.set(currentUserAtom, asUser(2));
    });

    await waitFor(() => {
      expect(store.get(likedProductsOwnerAtom)).toBe(2);
    });
    expect(hook.result.current.isLiked).toBe(false);
    expect(store.get(likedProductsAtom)).toEqual([like(999)]);
  });

  it("can retry after a failed fetch", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    (apiClient.get as jest.Mock).mockRejectedValueOnce(new Error("Network error"));

    const store = createStore();
    store.set(currentUserAtom, asUser(1));
    const { hook } = await renderUseProductLike(store);

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    // A failed fetch must not be recorded as "loaded" — otherwise it could never retry.
    expect(store.get(likedProductsOwnerAtom)).toBeNull();

    // A later identity change (or re-render) retries against a healthy backend.
    (apiClient.get as jest.Mock).mockResolvedValue({ data: [like(123)] });
    await act(async () => {
      store.set(currentUserAtom, asUser(3));
    });

    await waitFor(() => expect(hook.result.current.isLiked).toBe(true));
    consoleError.mockRestore();
  });

  it("should redirect to auth when toggling like without token", async () => {
    const originalHref = window.location.href;

    const { hook } = await renderUseProductLike();
    const module = await import("../useProductLike");
    const redirectSpy = jest
      .spyOn(module.navigationUtils, "setWindowLocation")
      .mockImplementation(() => {});

    const mockEvent = {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    } as unknown as React.MouseEvent<HTMLButtonElement>;

    await act(async () => {
      await hook.result.current.toggleLike(mockEvent);
    });

    await waitFor(() => {
      expect(mockEvent.preventDefault).toHaveBeenCalled();
    });

    expect(redirectSpy).toHaveBeenCalled();

    window.location.href = originalHref;
    redirectSpy.mockRestore();
  });

  it("should toggle like status when clicking", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    (apiClient.post as jest.Mock).mockResolvedValue({ isFavorite: true });

    const store = createStore();
    store.set(currentUserAtom, asUser(1));
    const { hook } = await renderUseProductLike(store);

    const mockEvent = {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    } as unknown as React.MouseEvent<HTMLButtonElement>;

    await act(async () => {
      await hook.result.current.toggleLike(mockEvent);
    });

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalled();
    });
  });

  it("should handle errors when toggling like", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    (apiClient.post as jest.Mock).mockRejectedValue(new Error("Network error"));

    const store = createStore();
    store.set(currentUserAtom, asUser(1));
    const { hook } = await renderUseProductLike(store);

    const mockEvent = {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    } as unknown as React.MouseEvent<HTMLButtonElement>;

    await act(async () => {
      await hook.result.current.toggleLike(mockEvent);
    });

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalled();
    });

    consoleError.mockRestore();
  });
  it("coalesces duplicate clicks and uses the authoritative response", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    let resolve!: (value: unknown) => void;
    (apiClient.post as jest.Mock).mockImplementation(() => new Promise(r => { resolve = r; }));
    const store = createStore();
    store.set(currentUserAtom, asUser(1));
    const { hook } = await renderUseProductLike(store);
    const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() } as any;
    let first!: Promise<void>;
    await act(async () => {
      first = hook.result.current.toggleLike(event);
      await hook.result.current.toggleLike(event);
    });
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith(expect.any(String), { productId: "123", isFavorite: true });
    await act(async () => { resolve({ isFavorite: false }); await first; });
    expect(hook.result.current.isLiked).toBe(false);
  });

  it("discards an in-flight mutation after switching identity", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockResolvedValue(mockToken);
    let resolve!: (value: unknown) => void;
    (apiClient.post as jest.Mock).mockImplementation(() => new Promise(r => { resolve = r; }));
    const store = createStore();
    store.set(currentUserAtom, asUser(1));
    const { hook } = await renderUseProductLike(store);
    let request!: Promise<void>;
    await act(async () => { request = hook.result.current.toggleLike({ preventDefault() {}, stopPropagation() {} } as any); });
    await act(async () => { store.set(currentUserAtom, asUser(2)); });
    await act(async () => { resolve({ isFavorite: true }); await request; });
    expect(store.get(likedProductsAtom)).toEqual([]);
    expect(store.get(likedProductsOwnerAtom)).toBe(2);
  });

});
