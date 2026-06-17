import {
  MANAGEMENT_ROLE_NAMES,
  buildManagerRoleFilterQuery,
  translatePluginRoleLabel,
} from "@/constants/roleLabels";

describe("management role filter", () => {
  it("includes exactly the four management plugin roles", () => {
    expect([...MANAGEMENT_ROLE_NAMES]).toEqual([
      "Superadmin",
      "Store manager",
      "Founder",
      "Editor",
    ]);
  });

  it("builds an indexed Strapi $in filter on role.name with URL-encoded values", () => {
    const query = buildManagerRoleFilterQuery();

    expect(query).toBe(
      "filters[role][name][$in][0]=Superadmin&" +
        "filters[role][name][$in][1]=Store%20manager&" +
        "filters[role][name][$in][2]=Founder&" +
        "filters[role][name][$in][3]=Editor",
    );
    // No leading separator so callers can append with their own "&".
    expect(query.startsWith("&")).toBe(false);
  });
});

describe("translatePluginRoleLabel", () => {
  it("maps known roles to Persian and falls back to the raw name", () => {
    expect(translatePluginRoleLabel("Superadmin")).toBe("سوپر ادمین");
    expect(translatePluginRoleLabel("Unknown")).toBe("Unknown");
    expect(translatePluginRoleLabel(null)).toBe("");
  });
});
