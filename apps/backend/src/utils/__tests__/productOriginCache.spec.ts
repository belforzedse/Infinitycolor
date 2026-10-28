const delByPattern = jest.fn().mockResolvedValue(1);
const triggerFrontendRevalidation = jest.fn().mockResolvedValue({
  attempted: 1,
  successful: 1,
  failed: 0,
});

jest.mock("../responseCache", () => ({
  delByPattern: (...args: unknown[]) => delByPattern(...args),
}));

jest.mock("../revalidate", () => ({
  triggerFrontendRevalidation: (...args: unknown[]) => triggerFrontendRevalidation(...args),
}));

import {
  clearAllProductCaches,
  clearProductOriginCaches,
  productSlugTag,
} from "../productOriginCache";

const clearByUid = jest.fn().mockResolvedValue(undefined);

const makeStrapi = () => ({
  log: { warn: jest.fn() },
  plugin: (name: string) =>
    name === "rest-cache" ? { service: () => ({ clearByUid }) } : undefined,
});

describe("clearProductOriginCaches", () => {
  beforeEach(() => jest.clearAllMocks());

  // The 60s Redis endpoint cache holds the by-slug payload and is purged only by
  // product publication, so a stock move has to clear it explicitly.
  it("always clears the by-slug endpoint cache", async () => {
    await clearProductOriginCaches(makeStrapi() as any, "shirt", { availabilityCrossed: false });
    expect(delByPattern).toHaveBeenCalledWith("endpoint-cache:product.");
  });

  it("drops every listing only when availability crossed zero", async () => {
    await clearProductOriginCaches(makeStrapi() as any, "shirt", { availabilityCrossed: true });

    expect(clearByUid).toHaveBeenCalledWith("api::product.product", {}, true);
    expect(triggerFrontendRevalidation).toHaveBeenCalledWith(
      { type: "product", path: "shirt" },
      expect.any(String),
    );
  });

  // Below the threshold only the PDP's number moved. Invalidating the card list
  // cache and every collection tag for that would be pure churn.
  it("touches only the product's own tag when just the low-stock number moved", async () => {
    await clearProductOriginCaches(makeStrapi() as any, "shirt", { availabilityCrossed: false });

    expect(clearByUid).not.toHaveBeenCalled();
    expect(triggerFrontendRevalidation).toHaveBeenCalledWith(
      { tag: "product:slug:shirt" },
      expect.any(String),
    );
  });

  // `path` is checked before `tag` in the storefront route, so sending both
  // would silently fall into the wider branch.
  it("sends the narrow payload without a path", async () => {
    await clearProductOriginCaches(makeStrapi() as any, "shirt", { availabilityCrossed: false });
    const [payload] = triggerFrontendRevalidation.mock.calls[0];
    expect(payload).not.toHaveProperty("path");
  });

  it("survives a missing rest-cache plugin rather than failing the purge", async () => {
    const strapi = { log: { warn: jest.fn() }, plugin: () => undefined };
    await expect(
      clearProductOriginCaches(strapi as any, "shirt", { availabilityCrossed: true }),
    ).resolves.toBeUndefined();
    expect(triggerFrontendRevalidation).toHaveBeenCalled();
  });

  it("survives a storefront that refuses the revalidation", async () => {
    triggerFrontendRevalidation.mockRejectedValueOnce(new Error("unreachable"));
    const strapi = makeStrapi();
    await expect(
      clearProductOriginCaches(strapi as any, "shirt", { availabilityCrossed: false }),
    ).resolves.toBeUndefined();
    expect(strapi.log.warn).toHaveBeenCalled();
  });
});

describe("clearAllProductCaches", () => {
  beforeEach(() => jest.clearAllMocks());

  // A shared colour row is rendered by every product using it; `product` is the
  // tag every PDP, PLP, colour filter and homepage rail carries.
  it("clears every product layer with one storefront tag", async () => {
    await clearAllProductCaches(makeStrapi() as any, "color");

    expect(delByPattern).toHaveBeenCalledWith("endpoint-cache:product.");
    expect(clearByUid).toHaveBeenCalledWith("api::product.product", {}, true);
    expect(triggerFrontendRevalidation).toHaveBeenCalledTimes(1);
    expect(triggerFrontendRevalidation).toHaveBeenCalledWith({ tag: "product" }, "color");
  });

  it("never fails the write that triggered it", async () => {
    delByPattern.mockRejectedValueOnce(new Error("redis down"));
    triggerFrontendRevalidation.mockRejectedValueOnce(new Error("unreachable"));
    const strapi = makeStrapi();

    await expect(clearAllProductCaches(strapi as any)).resolves.toBeUndefined();
    expect(clearByUid).toHaveBeenCalled();
    expect(strapi.log.warn).toHaveBeenCalledTimes(2);
  });
});

describe("productSlugTag", () => {
  // Must match `productSlugTag` in apps/frontend/src/constants/cacheTags.ts, or
  // the backend revalidates a tag no page is registered under.
  it("matches the storefront tag format", () => {
    expect(productSlugTag("shirt")).toBe("product:slug:shirt");
  });

  it("decodes so an encoded and a decoded caller agree", () => {
    expect(productSlugTag(encodeURIComponent("پیراهن"))).toBe("product:slug:پیراهن");
  });

  it("tolerates a malformed escape", () => {
    expect(productSlugTag("100%-cotton")).toBe("product:slug:100%-cotton");
  });
});
