describe("centralLoginUrl", () => {
  it("marks step-up so central auth will not silently continue a stale session", () => {
    const { centralLoginUrl } = require("./central-auth") as typeof import("./central-auth");
    const url = new URL(centralLoginUrl("/account", { stepUp: true }));
    expect(url.pathname).toBe("/auth");
    expect(url.searchParams.get("stepUp")).toBe("1");
    expect(url.searchParams.get("returnTo")).toBe("http://localhost:2891/account");
  });

  it("omits stepUp for ordinary login restores", () => {
    const { centralLoginUrl } = require("./central-auth") as typeof import("./central-auth");
    const url = new URL(centralLoginUrl("/orders"));
    expect(url.searchParams.get("stepUp")).toBeNull();
    expect(url.searchParams.get("returnTo")).toBe("http://localhost:2891/orders");
  });
});
