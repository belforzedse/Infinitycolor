import {
  isSessionFreshnessError,
  sessionsNeedStepUp,
  shouldRedirectAccountToLogin,
} from "../sessionAccess";

describe("admin account session access", () => {
  it("does not send a still-valid admin session back to login when listing sessions is stale", () => {
    const stale = { status: 403, code: "SESSION_NOT_FRESH" };
    expect(isSessionFreshnessError(stale)).toBe(true);
    expect(sessionsNeedStepUp(stale)).toBe(true);
    expect(shouldRedirectAccountToLogin(stale, "sessions")).toBe(false);
  });

  it("does not login-loop when session listing returns 401 while the profile JWT still works", () => {
    const unauthorized = { status: 401, code: "UNAUTHORIZED" };
    expect(shouldRedirectAccountToLogin(unauthorized, "sessions")).toBe(false);
    expect(sessionsNeedStepUp(unauthorized)).toBe(true);
  });

  it("still restores the shell when the profile request itself is unauthorized", () => {
    const unauthorized = { status: 401, code: "UNAUTHORIZED" };
    expect(shouldRedirectAccountToLogin(unauthorized, "profile")).toBe(true);
  });

  it("leaves ordinary session errors on the page", () => {
    const failed = { status: 500, message: "upstream" };
    expect(shouldRedirectAccountToLogin(failed, "sessions")).toBe(false);
    expect(sessionsNeedStepUp(failed)).toBe(false);
    expect(shouldRedirectAccountToLogin(failed, "profile")).toBe(false);
  });
});
