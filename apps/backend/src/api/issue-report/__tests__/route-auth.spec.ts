import routes from "../routes/issue-report";
import { ADMIN_ROLE_IDS, hasCapability } from "@repo/auth-core";

describe("issue report routes", () => {
  it("allows the public role to create without CAPTCHA or OTP middleware", () => {
    const create = routes.routes.find((route) => route.handler === "issue-report.create");
    expect(create).toMatchObject({
      method: "POST",
      path: "/issue-reports",
      config: { auth: { scope: [] }, policies: [], middlewares: [] },
    });
  });

  it("protects every management action with the issue report capability", () => {
    const adminRoutes = routes.routes.filter((route) => route.handler !== "issue-report.create");
    expect(adminRoutes).toHaveLength(4);
    for (const route of adminRoutes) {
      expect(route.config.policies).toEqual([
        {
          name: "global::require-capability",
          config: { capability: "system.issueReports.manage" },
        },
      ]);
    }
  });

  it("grants report management only to the canonical super-admin role", () => {
    for (const role of ADMIN_ROLE_IDS) {
      expect(hasCapability(role, "system.issueReports.manage")).toBe(role === "superadmin");
    }
  });
});
