/**
 * A bulk price edit sends only `Price`, so a variation whose stored
 * DiscountPrice is at or above the new price is refused. That refusal used to
 * be a plain Error, which Strapi turns into a bare 500 and the admin could not
 * say which row failed or why.
 */
import { describe, it, expect, jest } from "@jest/globals";

jest.mock("@strapi/strapi", () => ({
  factories: { createCoreService: (_uid: string, fn: any) => fn },
}));

import serviceFactory from "../services/product-variation";

const buildService = (existing: Record<string, unknown> | null) => {
  const strapi = {
    entityService: { findOne: jest.fn(async () => existing) },
  };
  return (serviceFactory as any)({ strapi });
};

describe("product-variation service price validation", () => {
  it("refuses a price at or below the stored discount with a 400-class ValidationError", async () => {
    // Postgres bigints come back as strings.
    const service = buildService({ Price: "0", DiscountPrice: "3500000" });

    await expect(service.update(9, { data: { Price: 3499000 } })).rejects.toMatchObject({
      name: "ValidationError",
      message: "قیمت تخفیف باید کمتر از قیمت اصلی باشد",
    });
  });

  it("stores a zero discount as no discount", async () => {
    const service = buildService({ Price: "1999000", DiscountPrice: null });
    const params = { data: { DiscountPrice: 0 } };
    // super.update is Strapi's; stop right after validation.
    await service.update(9, params).catch(() => undefined);
    expect(params.data.DiscountPrice).toBeNull();
  });

  it("reports a missing variation as NotFoundError", async () => {
    const service = buildService(null);

    await expect(service.update(9, { data: { Price: 3499000 } })).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("refuses a discount on create without a base price", async () => {
    const service = buildService(null);

    await expect(service.create({ data: { DiscountPrice: 1000 } })).rejects.toMatchObject({
      name: "ValidationError",
      message: "قیمت اصلی الزامی است",
    });
  });
});
