// jest.mock is hoisted above the imports, so the fns must be created inside it.
jest.mock("@/lib/central-auth", () => ({
  centralAuth: { tokenManager: { peek: jest.fn(), getToken: jest.fn() } },
}));

import { centralAuth } from "@/lib/central-auth";
import { hasActiveSession } from "../auth";

const peek = centralAuth.tokenManager.peek as jest.Mock;
const getToken = centralAuth.tokenManager.getToken as jest.Mock;

/**
 * The comment and like gates asked `peek()`, which only reads the in-memory
 * cache. On a fresh page load — or straight after returning from central auth —
 * that is empty for someone who is genuinely signed in, so Infinitygram told
 * those users to sign in again while the rest of the app treated them as
 * authenticated.
 */
describe("hasActiveSession", () => {
  beforeEach(() => {
    peek.mockReset();
    getToken.mockReset();
  });

  it("accepts a cached token without a network round trip", async () => {
    peek.mockReturnValue("cached.jwt.value");

    await expect(hasActiveSession()).resolves.toBe(true);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("still recognises a signed-in visitor whose cache is cold", async () => {
    peek.mockReturnValue(null);
    getToken.mockResolvedValue("refreshed.jwt.value");

    await expect(hasActiveSession()).resolves.toBe(true);
    expect(getToken).toHaveBeenCalled();
  });

  it("reports no session when the token cannot be acquired", async () => {
    peek.mockReturnValue(null);
    getToken.mockResolvedValue(null);

    await expect(hasActiveSession()).resolves.toBe(false);
  });

  it("treats a failing refresh as no session rather than throwing", async () => {
    peek.mockReturnValue(null);
    getToken.mockRejectedValue(new Error("network down"));

    await expect(hasActiveSession()).resolves.toBe(false);
  });
});
