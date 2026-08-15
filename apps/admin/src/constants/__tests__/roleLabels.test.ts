import {
  isAssignablePluginRole,
  resolveUserRoleLabel,
} from "../roleLabels";

describe("resolveUserRoleLabel", () => {
  it("shows the canonical plugin role after an assignment changes", () => {
    expect(
      resolveUserRoleLabel({
        role: { name: "Finance" },
        user_role: { Title: "مشتری" },
      }),
    ).toBe("مالی");
  });

  it("falls back to the legacy role only for unmigrated records", () => {
    expect(resolveUserRoleLabel({ user_role: { Title: "نقش قدیمی" } })).toBe(
      "نقش قدیمی",
    );
  });

  it("renders a placeholder when neither role exists", () => {
    expect(resolveUserRoleLabel({})).toBe("-");
  });

  it("translates and permits assignment of Store Manager 2", () => {
    expect(
      resolveUserRoleLabel({ role: { name: "Store Manager 2" } }),
    ).toBe("مدیر فروشگاه ۲");
    expect(isAssignablePluginRole({ type: "store-manager-2" })).toBe(true);
  });
});
