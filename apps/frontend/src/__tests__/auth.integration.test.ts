import { apiClient } from "@/services";
import { handleAuthErrors } from "@/utils/auth";
import { HTTP_STATUS, ERROR_MESSAGES } from "@/constants/api";
import { currentUserAtom } from "@/lib/atoms/auth";
import { jotaiStore } from "@/lib/jotaiStore";

describe("Authentication flows", () => {
  beforeEach(() => {
    localStorage.clear();
    jotaiStore.set(currentUserAtom, null);
  });

  it("clears token and redirects to auth on unauthorized", async () => {
    localStorage.setItem("accessToken", "token");
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: HTTP_STATUS.UNAUTHORIZED,
      json: async () => ({}),
    });

    await expect(apiClient.get("/protected")).rejects.toEqual({
      message: ERROR_MESSAGES.DEFAULT,
      status: HTTP_STATUS.UNAUTHORIZED,
      errors: undefined,
    });

    expect(localStorage.getItem("accessToken")).toBeNull();
  });

  it("redirects non-admin users to account", () => {
    localStorage.setItem("accessToken", "token");
    handleAuthErrors(null, false);
    expect(localStorage.getItem("accessToken")).toBe("token");
  });

  it("keeps customer session state on forbidden API errors", async () => {
    const user = {
      id: 7,
      Phone: "09120000000",
      FirstName: "Test",
      LastName: "Customer",
      IsActive: true,
      IsVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      roleName: "Customer",
    };

    localStorage.setItem("accessToken", "token");
    jotaiStore.set(currentUserAtom, user as any);
    window.history.pushState({}, "", "/orders/123");
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: HTTP_STATUS.FORBIDDEN,
      json: async () => ({ error: { message: "Forbidden" } }),
    });

    await expect(apiClient.get("/orders/123/payment-status")).rejects.toEqual({
      message: "Forbidden",
      status: HTTP_STATUS.FORBIDDEN,
      errors: undefined,
    });

    expect(localStorage.getItem("accessToken")).toBe("token");
    expect(jotaiStore.get(currentUserAtom)).toEqual(user);
    expect(window.location.pathname).toBe("/orders/123");
  });
});
