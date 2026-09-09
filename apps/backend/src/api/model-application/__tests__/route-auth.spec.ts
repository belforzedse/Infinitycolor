import routes from "../routes/model-application";
import { ADMIN_ROLE_IDS, hasCapability } from "@repo/auth-core";

describe("model application routes", () => {
  it("allows the public role to create without CAPTCHA or OTP middleware", () => {
    const create = routes.routes.find((route) => route.handler === "model-application.create");
    expect(create).toMatchObject({
      method: "POST",
      path: "/model-applications",
      config: { auth: { scope: [] }, policies: [], middlewares: [] },
    });
  });

  it("protects every management action with the model application capability", () => {
    const adminRoutes = routes.routes.filter((route) => route.handler !== "model-application.create");
    expect(adminRoutes).toHaveLength(3);
    for (const route of adminRoutes) {
      expect(route.config.policies).toEqual([
        {
          name: "global::require-capability",
          config: { capability: "system.modelApplications.manage" },
        },
      ]);
    }
  });

  it("grants application management to founder and superadmin only", () => {
    for (const role of ADMIN_ROLE_IDS) {
      expect(hasCapability(role, "system.modelApplications.manage")).toBe(
        role === "founder" || role === "superadmin",
      );
    }
  });
});
