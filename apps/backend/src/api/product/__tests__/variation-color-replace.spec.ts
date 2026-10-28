const clearProductOriginCaches = jest.fn().mockResolvedValue(undefined);
const deleteVariationWithStock = jest.fn().mockResolvedValue({ id: 0 });

jest.mock("../../../utils/productOriginCache", () => ({
  clearProductOriginCaches: (...args: unknown[]) => clearProductOriginCaches(...args),
}));

jest.mock("../../product-variation/services/variation-removal", () => ({
  deleteVariationWithStock: (...args: unknown[]) => deleteVariationWithStock(...args),
}));

import { generatedSku } from "../services/variation-combinations";
import {
  ColorReplaceError,
  replaceProductVariationColor,
} from "../services/variation-color-replace";

type Row = {
  id: number;
  color?: number;
  size?: number;
  sku?: string;
  published?: boolean;
  price?: number;
  stock?: { Count: number; reservedCount: number } | null;
  orders?: number;
};

const PRODUCT_ID = 5;
const RED = 1;
const BLUE = 2;
const GREEN = 3;
const S = 21;
const M = 22;

const sizeTitles: Record<number, string> = { [S]: "S", [M]: "M" };

function makeStrapi(rows: Row[], colors: Array<{ id: number; Title: string; ColorCode: string | null }>) {
  const trx = { raw: jest.fn().mockResolvedValue(undefined) };
  const byId = new Map(rows.map((row) => [row.id, row]));

  const entityService = {
    findMany: jest.fn(async () =>
      rows.map((row) => ({
        id: row.id,
        AttributeSignature: null,
        SKU: row.sku ?? `SKU-${row.id}`,
        IsPublished: row.published ?? true,
        Price: row.price ?? 100,
        product_variation_color: row.color
          ? { id: row.color, Title: colors.find((c) => c.id === row.color)?.Title }
          : null,
        product_variation_size: row.size ? { id: row.size, Title: sizeTitles[row.size] } : null,
        product_variation_model: null,
        selected_attribute_terms: [],
      })),
    ),
    update: jest.fn(async (_uid: string, id: number, params: any) => ({ id, ...params.data })),
    create: jest.fn(async (_uid: string, params: any) => ({ id: 99, ...params.data })),
  };

  const queries: Record<string, any> = {
    "api::product.product": {
      findOne: jest.fn(async ({ where }: any) =>
        where.id === PRODUCT_ID ? { id: PRODUCT_ID, Slug: "shirt" } : null,
      ),
    },
    "api::product-variation-color.product-variation-color": {
      findOne: jest.fn(async ({ where }: any) => colors.find((c) => c.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        colors.filter(
          (c) =>
            c.Title === where.Title &&
            (where.ColorCode.$null
              ? c.ColorCode === null
              : (c.ColorCode || "").toLowerCase() === where.ColorCode.$eqi),
        ),
      ),
    },
    "api::product-variation.product-variation": {
      findOne: jest.fn(async ({ where }: any) => {
        const row = byId.get(where.id);
        return row ? { id: row.id, product_stock: row.stock ?? null } : null;
      }),
    },
    "api::order-item.order-item": {
      count: jest.fn(async ({ where }: any) => byId.get(where.product_variation.id)?.orders ?? 0),
    },
  };

  return {
    trx,
    entityService,
    queries,
    strapi: {
      entityService,
      db: {
        transaction: jest.fn(async (callback: any) => callback({ trx })),
        query: jest.fn((uid: string) => queries[uid]),
      },
    },
  };
}

const COLORS = [
  { id: RED, Title: "قرمز", ColorCode: "#ff0000" },
  { id: BLUE, Title: "آبی", ColorCode: "#0000ff" },
  { id: GREEN, Title: "سبز", ColorCode: "#00ff00" },
];

const redS = { id: 11, color: RED, size: S, sku: generatedSku(PRODUCT_ID, `color=${RED}|size=${S}`) };
const redM = { id: 12, color: RED, size: M, sku: "CUSTOM-M" };
const greenS = { id: 13, color: GREEN, size: S };

async function expectReplaceError(promise: Promise<unknown>, errorCode: string, status: number) {
  await expect(promise).rejects.toBeInstanceOf(ColorReplaceError);
  await promise.catch((error) => {
    expect(error.errorCode).toBe(errorCode);
    expect(error.status).toBe(status);
  });
}

describe("replaceProductVariationColor", () => {
  beforeEach(() => jest.clearAllMocks());

  it("re-points every variation of the colour and keeps everything else", async () => {
    const { strapi, entityService, trx } = makeStrapi([redS, redM, greenS], COLORS);

    const result = await replaceProductVariationColor(strapi, {
      productId: PRODUCT_ID,
      fromColorId: RED,
      toColorId: BLUE,
    });

    expect(trx.raw).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(?, ?)", [845_733, PRODUCT_ID]);
    expect(entityService.update).toHaveBeenCalledTimes(2);
    // Only the colour, its signature and a generated SKU move; price, stock and
    // publication are never part of the write.
    expect(entityService.update).toHaveBeenCalledWith("api::product-variation.product-variation", 11, {
      data: {
        product_variation_color: BLUE,
        AttributeSignature: `color=${BLUE}|size=${S}`,
        SKU: generatedSku(PRODUCT_ID, `color=${BLUE}|size=${S}`),
      },
    });
    expect(entityService.update).toHaveBeenCalledWith("api::product-variation.product-variation", 12, {
      data: { product_variation_color: BLUE, AttributeSignature: `color=${BLUE}|size=${M}` },
    });
    expect(entityService.create).not.toHaveBeenCalled();
    expect(clearProductOriginCaches).toHaveBeenCalledTimes(1);
    expect(clearProductOriginCaches).toHaveBeenCalledWith(strapi, "shirt", {
      availabilityCrossed: true,
      logPrefix: "variation-color-replace",
    });
    expect(result.moving.map((entry) => entry.label)).toEqual(["S", "M"]);
    expect(result.targetColor).toEqual({ id: BLUE, title: "آبی", colorCode: "#0000ff", created: false });
  });

  it("writes nothing and clears nothing on a dry run", async () => {
    const { strapi, entityService } = makeStrapi([redS, redM], COLORS);

    const result = await replaceProductVariationColor(strapi, {
      productId: PRODUCT_ID,
      fromColorId: RED,
      toColorId: BLUE,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.moving).toHaveLength(2);
    expect(entityService.update).not.toHaveBeenCalled();
    expect(clearProductOriginCaches).not.toHaveBeenCalled();
  });

  it("refuses when a real variation already holds the new combination", async () => {
    const blueS = { id: 14, color: BLUE, size: S, published: true };
    const { strapi, entityService } = makeStrapi([redS, redM, blueS], COLORS);

    const preview = await replaceProductVariationColor(strapi, {
      productId: PRODUCT_ID,
      fromColorId: RED,
      toColorId: BLUE,
      dryRun: true,
    });
    expect(preview.blocking).toEqual([
      expect.objectContaining({ id: 14, label: "S", movingId: 11, reason: "occupied" }),
    ]);

    await expectReplaceError(
      replaceProductVariationColor(strapi, { productId: PRODUCT_ID, fromColorId: RED, toColorId: BLUE }),
      "COLOR_REPLACE_CONFLICT",
      409,
    );
    expect(entityService.update).not.toHaveBeenCalled();
    expect(clearProductOriginCaches).not.toHaveBeenCalled();
  });

  it("treats a draft holding stock as real, not as a leftover", async () => {
    const blueS = { id: 14, color: BLUE, size: S, published: false, price: 0, stock: { Count: 3, reservedCount: 0 } };
    const { strapi } = makeStrapi([redS, blueS], COLORS);

    const preview = await replaceProductVariationColor(strapi, {
      productId: PRODUCT_ID,
      fromColorId: RED,
      toColorId: BLUE,
      dryRun: true,
    });
    expect(preview.emptyDrafts).toEqual([]);
    expect(preview.blocking).toHaveLength(1);
  });

  describe("empty drafts left by generating the right colour", () => {
    const emptyBlueS = { id: 14, color: BLUE, size: S, published: false, price: 0, stock: null };

    it("asks for confirmation before removing them", async () => {
      const { strapi, entityService } = makeStrapi([redS, redM, emptyBlueS], COLORS);

      const preview = await replaceProductVariationColor(strapi, {
        productId: PRODUCT_ID,
        fromColorId: RED,
        toColorId: BLUE,
        dryRun: true,
      });
      expect(preview.emptyDrafts).toEqual([expect.objectContaining({ id: 14, label: "S" })]);
      expect(preview.blocking).toEqual([]);

      await expectReplaceError(
        replaceProductVariationColor(strapi, { productId: PRODUCT_ID, fromColorId: RED, toColorId: BLUE }),
        "COLOR_REPLACE_DRAFTS_PENDING",
        409,
      );
      expect(deleteVariationWithStock).not.toHaveBeenCalled();
      expect(entityService.update).not.toHaveBeenCalled();
    });

    it("needs the variation-delete capability to remove them", async () => {
      const { strapi, entityService } = makeStrapi([redS, emptyBlueS], COLORS);

      await expectReplaceError(
        replaceProductVariationColor(strapi, {
          productId: PRODUCT_ID,
          fromColorId: RED,
          toColorId: BLUE,
          removeEmptyDrafts: true,
          canDeleteVariations: false,
        }),
        "VARIATION_DELETE_FORBIDDEN",
        403,
      );
      expect(deleteVariationWithStock).not.toHaveBeenCalled();
      expect(entityService.update).not.toHaveBeenCalled();
    });

    it("removes them inside the transaction before moving the real variations", async () => {
      const { strapi, entityService, trx } = makeStrapi([redS, redM, emptyBlueS], COLORS);
      const order: string[] = [];
      deleteVariationWithStock.mockImplementation(async (_strapi: unknown, id: number) => {
        order.push(`delete:${id}`);
        return { id };
      });
      entityService.update.mockImplementation(async (_uid: string, id: number) => {
        order.push(`update:${id}`);
        return { id };
      });

      await replaceProductVariationColor(strapi, {
        productId: PRODUCT_ID,
        fromColorId: RED,
        toColorId: BLUE,
        removeEmptyDrafts: true,
        canDeleteVariations: true,
      });

      expect(deleteVariationWithStock).toHaveBeenCalledWith(strapi, 14, trx);
      expect(order).toEqual(["delete:14", "update:11", "update:12"]);
    });

    it("never counts an ordered draft as empty", async () => {
      const { strapi } = makeStrapi([redS, { ...emptyBlueS, orders: 1 }], COLORS);

      const preview = await replaceProductVariationColor(strapi, {
        productId: PRODUCT_ID,
        fromColorId: RED,
        toColorId: BLUE,
        dryRun: true,
      });
      expect(preview.emptyDrafts).toEqual([]);
      expect(preview.blocking).toHaveLength(1);
    });
  });

  describe("a new colour typed in the dialog", () => {
    it("reuses an identical existing colour instead of adding a duplicate", async () => {
      const { strapi, entityService } = makeStrapi([redS], COLORS);

      const result = await replaceProductVariationColor(strapi, {
        productId: PRODUCT_ID,
        fromColorId: RED,
        newColor: { title: " آبی ", colorCode: "0000FF" },
      });

      expect(entityService.create).not.toHaveBeenCalled();
      expect(result.targetColor).toEqual(expect.objectContaining({ id: BLUE, created: false }));
      expect(entityService.update).toHaveBeenCalledWith(
        "api::product-variation.product-variation",
        11,
        expect.objectContaining({ data: expect.objectContaining({ product_variation_color: BLUE }) }),
      );
    });

    it("creates it, normalised, only when applying", async () => {
      const { strapi, entityService } = makeStrapi([redS], COLORS);

      const preview = await replaceProductVariationColor(strapi, {
        productId: PRODUCT_ID,
        fromColorId: RED,
        newColor: { title: "قرمز", colorCode: "#E0115F" },
        dryRun: true,
      });
      expect(preview.targetColor).toEqual({ id: null, title: "قرمز", colorCode: "#e0115f", created: true });
      expect(entityService.create).not.toHaveBeenCalled();

      const result = await replaceProductVariationColor(strapi, {
        productId: PRODUCT_ID,
        fromColorId: RED,
        newColor: { title: "قرمز", colorCode: "#E0115F" },
      });
      expect(entityService.create).toHaveBeenCalledWith(
        "api::product-variation-color.product-variation-color",
        { data: { Title: "قرمز", ColorCode: "#e0115f" } },
      );
      expect(result.targetColor.id).toBe(99);
      expect(entityService.update).toHaveBeenCalledWith(
        "api::product-variation.product-variation",
        11,
        expect.objectContaining({ data: expect.objectContaining({ product_variation_color: 99 }) }),
      );
    });

    it("rejects a malformed hex", async () => {
      const { strapi } = makeStrapi([redS], COLORS);
      await expectReplaceError(
        replaceProductVariationColor(strapi, {
          productId: PRODUCT_ID,
          fromColorId: RED,
          newColor: { title: "قرمز", colorCode: "#12" },
        }),
        "COLOR_REPLACE_INVALID",
        400,
      );
    });
  });

  it("rejects replacing a colour with itself", async () => {
    const { strapi } = makeStrapi([redS], COLORS);
    await expectReplaceError(
      replaceProductVariationColor(strapi, { productId: PRODUCT_ID, fromColorId: RED, toColorId: RED }),
      "SAME_COLOR",
      400,
    );
  });

  it("reports a colour the product does not use", async () => {
    const { strapi } = makeStrapi([greenS], COLORS);
    await expectReplaceError(
      replaceProductVariationColor(strapi, { productId: PRODUCT_ID, fromColorId: RED, toColorId: BLUE }),
      "COLOR_NOT_ON_PRODUCT",
      404,
    );
  });
});
