import {
  OPERATIONAL_CATEGORY_FIELDS,
  remapLegacyCategoryParentField,
} from "../lib/write-payload";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";

const strapi = {} as never;

function context(role: string, data: Record<string, unknown>) {
  return {
    state: { user: { id: 7, role: { name: role } } },
    request: { body: { data } },
    badRequest: jest.fn(),
  };
}

describe("product-category legacy Parent remap", () => {
  it("copies Parent onto parent so Founder can write the relation", async () => {
    const data: Record<string, unknown> = {
      Title: "کیف",
      Slug: "bags",
      Parent: "12",
    };
    remapLegacyCategoryParentField(data);

    expect(data.parent).toBe("12");
    expect(data).not.toHaveProperty("Parent");

    const ctx = context("Founder", data);
    await expect(
      enforceOperationalDataFields(ctx, strapi, OPERATIONAL_CATEGORY_FIELDS),
    ).resolves.toBe(true);
    expect(ctx.badRequest).not.toHaveBeenCalled();
  });

  it("still rejects unknown fields after the Parent remap", async () => {
    const data: Record<string, unknown> = {
      Title: "کیف",
      Slug: "bags",
      Parent: "12",
      secretField: true,
    };
    remapLegacyCategoryParentField(data);

    const ctx = context("Founder", data);
    await expect(
      enforceOperationalDataFields(ctx, strapi, OPERATIONAL_CATEGORY_FIELDS),
    ).resolves.toBe(false);
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "This role cannot write protected fields: secretField",
    );
  });

  it("keeps an explicit parent value when both keys are present", () => {
    const data: Record<string, unknown> = {
      parent: 9,
      Parent: "12",
    };
    remapLegacyCategoryParentField(data);
    expect(data.parent).toBe(9);
    expect(data).not.toHaveProperty("Parent");
  });
});
