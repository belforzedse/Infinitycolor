import { parseAdminFilters, type AdminFilterDefinition } from "../admin-list-query";

/**
 * The reserve-order filter exists so combined-shipping orders can be separated
 * from ordinary ones and printed on their own — they were coming off the printer
 * mixed into the «در حال انجام» batch.
 *
 * It is a relation-presence filter (`$notNull` on `reserve_shipment.id`), which
 * is an unusual shape for this parser: the operator carries the whole meaning and
 * there is no value to send. These pin that it survives parsing, because the
 * failure mode is a 400 that looks from the UI like an empty result set.
 */
const DEFINITIONS: Record<string, AdminFilterDefinition> = {
  "[reserve_shipment][id]": {
    path: ["reserve_shipment", "id"],
    type: "select",
  },
  "[Description]": { path: ["Description"], type: "text" },
};

function makeCtx() {
  return { badRequest: jest.fn() };
}

describe("parseAdminFilters relation-presence filters", () => {
  it("builds a nested $notNull filter without needing a value", () => {
    const ctx = makeCtx();

    const filters = parseAdminFilters(
      ctx,
      [{ field: "[reserve_shipment][id]", operator: "$notNull" }],
      DEFINITIONS,
      "order",
    );

    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(filters).toEqual([{ reserve_shipment: { id: { $notNull: true } } }]);
  });

  it("builds the inverse for orders that are not part of a parcel", () => {
    const ctx = makeCtx();

    const filters = parseAdminFilters(
      ctx,
      [{ field: "[reserve_shipment][id]", operator: "$null" }],
      DEFINITIONS,
      "order",
    );

    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(filters).toEqual([{ reserve_shipment: { id: { $null: true } } }]);
  });

  it("still rejects an operator the field type does not allow", () => {
    const ctx = makeCtx();

    const filters = parseAdminFilters(
      ctx,
      [{ field: "[reserve_shipment][id]", operator: "$containsi", value: "x" }],
      DEFINITIONS,
      "order",
    );

    expect(filters).toBeNull();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Unsupported order filter operator",
    );
  });

  it("still rejects an unknown field", () => {
    const ctx = makeCtx();

    const filters = parseAdminFilters(
      ctx,
      [{ field: "[isReserveOrder]", operator: "$eq", value: "true" }],
      DEFINITIONS,
      "order",
    );

    expect(filters).toBeNull();
    expect(ctx.badRequest).toHaveBeenCalledWith("Unsupported order filter field");
  });
});
