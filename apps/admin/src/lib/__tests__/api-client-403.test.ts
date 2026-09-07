import { jotaiStore } from "@/lib/jotaiStore";
import { currentUserAtom } from "@/lib/atoms/auth";
import { onHttpError } from "@/lib/api-client";
import type { MeResponse } from "@/services/user/me";

/**
 * A denied request must not look like a logout.
 *
 * The admin client previously nulled `currentUserAtom` and navigated away on any
 * HTTP 403. Because `ClientLayout` feeds that atom into the page guard, one
 * forbidden resource turned a correctly-permitted page into an error/redirect —
 * which is what Store Manager 2 hit on /orders/carts (a legitimate denial: the
 * capability belongs to Finance) and what sellers hit on size guides and media.
 *
 * `handleAuthErrors` is the single owner of auth responses: it clears the session
 * on 401 and only raises a notice on 403. These tests pin that split.
 */

/** Settle the chained dynamic imports the old 403 handler used. */
async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const SIGNED_IN = {
  id: 7,
  username: "storemanager2",
  email: "sm2@example.test",
} as unknown as MeResponse;

describe("admin auth error handling", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // jsdom ships no fetch; the 401 path calls it to drop the route hint.
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    jotaiStore.set(currentUserAtom, SIGNED_IN);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("keeps the signed-in identity when a single resource returns 403", async () => {
    onHttpError({ status: 403, message: "Forbidden" } as never, { status: 403 });
    await flushAsyncWork();

    expect(jotaiStore.get(currentUserAtom)).toEqual(SIGNED_IN);
  });

  it("clears the identity on 401 so a real session loss still signs out", async () => {
    onHttpError({ status: 401, message: "Unauthorized" } as never, { status: 401 });
    await flushAsyncWork();

    expect(jotaiStore.get(currentUserAtom)).toBeNull();
  });

  it("does not navigate away from the page on 403", async () => {
    const back = jest.fn();
    const originalBack = window.history.back;
    Object.defineProperty(window.history, "back", { configurable: true, value: back });

    try {
      onHttpError({ status: 403, message: "Forbidden" } as never, { status: 403 });
      // The removed handler resolved two dynamic imports and then bounced the
      // operator on a 100ms timer, so settle both before asserting.
      await flushAsyncWork();
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(back).not.toHaveBeenCalled();
      expect(jotaiStore.get(currentUserAtom)).toEqual(SIGNED_IN);
    } finally {
      Object.defineProperty(window.history, "back", {
        configurable: true,
        value: originalBack,
      });
    }
  });
});
