const clearAllProductCaches = jest.fn().mockResolvedValue(undefined);
const logManualActivity = jest.fn().mockResolvedValue(undefined);

jest.mock("../../../utils/productOriginCache", () => ({
  clearAllProductCaches: (...args: unknown[]) => clearAllProductCaches(...args),
}));
jest.mock("../../../utils/manualAdminActivity", () => ({
  logManualActivity: (...args: unknown[]) => logManualActivity(...args),
}));
jest.mock("../../../utils/audit", () => ({
  resolveAuditActor: (event: any) => event.actor ?? {},
}));

import lifecycles from "../content-types/product-variation-color/lifecycles";

describe("product-variation-color lifecycles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as any).strapi = { log: { warn: jest.fn() } };
  });

  // Editing a shared colour changes every product that uses it, none of which is
  // written, so without this the storefront kept the old swatch until expiry.
  it("refreshes every product surface when a colour is edited", async () => {
    await lifecycles.afterUpdate({ result: { id: 4, Title: "آبی" } } as any);
    expect(clearAllProductCaches).toHaveBeenCalledWith(
      (globalThis as any).strapi,
      "product-variation-color",
    );
  });

  it("refreshes even for edits without an audit actor", async () => {
    await lifecycles.afterUpdate({ result: { id: 4, Title: "آبی" }, actor: {} } as any);
    expect(clearAllProductCaches).toHaveBeenCalledTimes(1);
    expect(logManualActivity).not.toHaveBeenCalled();
  });

  it("refreshes when a colour is deleted", async () => {
    await lifecycles.afterDelete({ params: { where: { id: 4 } } } as any);
    expect(clearAllProductCaches).toHaveBeenCalledTimes(1);
  });

  it("does not touch caches for a new, unused colour", async () => {
    await lifecycles.afterCreate({ result: { id: 4, Title: "آبی" }, actor: { userId: 7 } } as any);
    expect(clearAllProductCaches).not.toHaveBeenCalled();
  });

  it("names the colour by its title in the audit log", async () => {
    await lifecycles.afterUpdate({ result: { id: 4, Title: "آبی" }, actor: { userId: 7 } } as any);
    expect(logManualActivity).toHaveBeenCalledWith(
      (globalThis as any).strapi,
      expect.objectContaining({ message: "رنگ آبی بروزرسانی شد", messageEn: "Color آبی updated" }),
    );
  });
});
