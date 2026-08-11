import {
  COMMERCE_DELETE_TARGETS,
  COMMERCE_KEEP_TARGETS,
} from "../../api/commerce-maintenance/services/commerce-maintenance";

describe("audit retention contract", () => {
  it("keeps canonical and legacy audit history out of commerce purges", () => {
    const deleted = COMMERCE_DELETE_TARGETS.map((target) => target.uid);
    expect(deleted).not.toContain("api::manual-admin-activity.manual-admin-activity");
    expect(deleted).not.toContain("api::admin-activity.admin-activity");
    expect(COMMERCE_KEEP_TARGETS).toEqual(expect.arrayContaining([
      "api::manual-admin-activity.manual-admin-activity",
      "api::admin-activity.admin-activity",
    ]));
  });
});
