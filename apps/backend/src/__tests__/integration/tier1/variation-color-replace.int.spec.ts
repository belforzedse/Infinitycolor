/**
 * Replacing a wrongly chosen colour on one product, against real PostgreSQL.
 *
 * What only a real database can show: the shared colour relation is a one-way
 * `oneToOne`, so re-pointing one product's variations must leave every other
 * product's link to the same colour alone; past order lines keep their own
 * colour; the empty-draft checks (stock row, order lines) and the colour lookup
 * operators (`$eqi`, `$null`) behave as the unit mocks assume; and the draft
 * removal and re-pointing commit or roll back together.
 */
import { replaceProductVariationColor } from "../../../api/product/services/variation-color-replace";
import { generatedSku } from "../../../api/product/services/variation-combinations";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories, TEST_PREFIX } from "../factories";

const VARIATION = "api::product-variation.product-variation";
const COLOR = "api::product-variation-color.product-variation-color";
const SIZE = "api::product-variation-size.product-variation-size";

let strapi: any;
let f: Factories;
let seq = 0;
const uniq = (label: string) => `${TEST_PREFIX}${label}_${Date.now()}_${seq++}`;

beforeAll(async () => {
  strapi = await setupStrapi();
});

beforeEach(() => {
  f = makeFactories(strapi);
});

afterEach(async () => {
  await f.cleanup();
});

afterAll(async () => {
  await teardownStrapi();
});

async function createColor(title: string, colorCode: string | null) {
  const row = await strapi.db.query(COLOR).create({ data: { Title: title, ColorCode: colorCode } });
  f.remember(COLOR, row.id);
  return row;
}

async function createSize(title: string) {
  const row = await strapi.db.query(SIZE).create({ data: { Title: title } });
  f.remember(SIZE, row.id);
  return row;
}

async function createProduct() {
  const slug = uniq("color-replace").toLowerCase();
  const row = await strapi.db.query("api::product.product").create({
    data: { Title: slug, Slug: slug, Status: "Active", external_source: TEST_PREFIX },
  });
  f.remember("api::product.product", row.id);
  return row;
}

/** A variation as generation builds it: signature, generated SKU, colour and size. */
async function createVariation(opts: {
  productId: number;
  colorId: number;
  sizeId: number;
  price?: number;
  isPublished?: boolean;
  stockCount?: number | null;
}) {
  const signature = `color=${opts.colorId}|size=${opts.sizeId}`;
  const stock =
    opts.stockCount === null ? null : await f.createStock({ count: opts.stockCount ?? 5 });
  const row = await strapi.entityService.create(VARIATION, {
    data: {
      product: opts.productId,
      SKU: generatedSku(opts.productId, signature),
      Price: opts.price ?? 100000,
      IsPublished: opts.isPublished ?? true,
      AttributeSignature: signature,
      product_variation_color: opts.colorId,
      product_variation_size: opts.sizeId,
      ...(stock ? { product_stock: stock.id } : {}),
    },
  });
  f.remember(VARIATION, row.id);
  return row;
}

async function readVariation(id: number) {
  return strapi.entityService.findOne(VARIATION, id, {
    populate: { product_variation_color: true, product_stock: true },
  });
}

describe("replacing a product's colour on real PostgreSQL", () => {
  it("moves one product's variations and leaves other products and past orders alone", async () => {
    const red = await createColor(uniq("red"), "#ff0000");
    const blue = await createColor(uniq("blue"), "#0000ff");
    const s = await createSize(uniq("S"));
    const m = await createSize(uniq("M"));
    const product = await createProduct();
    const other = await createProduct();

    const redS = await createVariation({ productId: product.id, colorId: red.id, sizeId: s.id, price: 250000, stockCount: 7 });
    const redM = await createVariation({ productId: product.id, colorId: red.id, sizeId: m.id, price: 260000, stockCount: 3 });
    // Left behind by generating the right colour next to the wrong one.
    const emptyBlueS = await createVariation({
      productId: product.id, colorId: blue.id, sizeId: s.id, price: 0, isPublished: false, stockCount: 0,
    });
    const otherRedS = await createVariation({ productId: other.id, colorId: red.id, sizeId: s.id });

    // A past sale of the wrong colour.
    const order = await f.createOrder({ status: "Done" });
    const orderItem = await f.createOrderItem({ orderId: order.id, variationId: redS.id });
    await strapi.db.query("api::order-item.order-item").update({
      where: { id: orderItem.id },
      data: { product_color: red.id },
    });

    const preview = await replaceProductVariationColor(strapi, {
      productId: product.id, fromColorId: red.id, toColorId: blue.id, dryRun: true,
    });
    expect(preview.moving.map((entry) => entry.id).sort()).toEqual([redS.id, redM.id].sort());
    expect(preview.emptyDrafts.map((entry) => entry.id)).toEqual([emptyBlueS.id]);
    expect(preview.blocking).toEqual([]);

    await expect(
      replaceProductVariationColor(strapi, { productId: product.id, fromColorId: red.id, toColorId: blue.id }),
    ).rejects.toMatchObject({ errorCode: "COLOR_REPLACE_DRAFTS_PENDING", status: 409 });
    expect((await readVariation(redS.id)).product_variation_color.id).toBe(red.id);

    await replaceProductVariationColor(strapi, {
      productId: product.id,
      fromColorId: red.id,
      toColorId: blue.id,
      removeEmptyDrafts: true,
      canDeleteVariations: true,
    });

    const movedS = await readVariation(redS.id);
    expect(movedS.product_variation_color.id).toBe(blue.id);
    expect(movedS.AttributeSignature).toBe(`color=${blue.id}|size=${s.id}`);
    expect(movedS.SKU).toBe(generatedSku(product.id, `color=${blue.id}|size=${s.id}`));
    // Everything the operator entered stays exactly where it was.
    expect(Number(movedS.Price)).toBe(250000);
    expect(movedS.IsPublished).toBe(true);
    expect(movedS.product_stock.Count).toBe(7);
    expect((await readVariation(redM.id)).product_variation_color.id).toBe(blue.id);

    expect(await strapi.db.query(VARIATION).findOne({ where: { id: emptyBlueS.id } })).toBeNull();
    // The shared colour and its other users are untouched.
    expect((await readVariation(otherRedS.id)).product_variation_color.id).toBe(red.id);
    expect(await strapi.db.query(COLOR).findOne({ where: { id: red.id } })).toMatchObject({
      ColorCode: "#ff0000",
    });
    const pastLine = await strapi.db.query("api::order-item.order-item").findOne({
      where: { id: orderItem.id },
      populate: ["product_color"],
    });
    expect(pastLine.product_color.id).toBe(red.id);
  });

  it("refuses and writes nothing when a real variation already has the combination", async () => {
    const red = await createColor(uniq("red"), "#ff0000");
    const blue = await createColor(uniq("blue"), "#0000ff");
    const s = await createSize(uniq("S"));
    const product = await createProduct();
    const redS = await createVariation({ productId: product.id, colorId: red.id, sizeId: s.id });
    // Unpublished, but it holds stock: someone put work into it.
    const blueS = await createVariation({
      productId: product.id, colorId: blue.id, sizeId: s.id, price: 0, isPublished: false, stockCount: 4,
    });

    await expect(
      replaceProductVariationColor(strapi, {
        productId: product.id,
        fromColorId: red.id,
        toColorId: blue.id,
        removeEmptyDrafts: true,
        canDeleteVariations: true,
      }),
    ).rejects.toMatchObject({ errorCode: "COLOR_REPLACE_CONFLICT", status: 409 });

    expect((await readVariation(redS.id)).product_variation_color.id).toBe(red.id);
    expect(await strapi.db.query(VARIATION).findOne({ where: { id: blueS.id } })).not.toBeNull();
  });

  it("never treats an ordered draft as empty", async () => {
    const red = await createColor(uniq("red"), "#ff0000");
    const blue = await createColor(uniq("blue"), "#0000ff");
    const s = await createSize(uniq("S"));
    const product = await createProduct();
    await createVariation({ productId: product.id, colorId: red.id, sizeId: s.id });
    const orderedDraft = await createVariation({
      productId: product.id, colorId: blue.id, sizeId: s.id, price: 0, isPublished: false, stockCount: null,
    });
    const order = await f.createOrder({ status: "Done" });
    await f.createOrderItem({ orderId: order.id, variationId: orderedDraft.id });

    const preview = await replaceProductVariationColor(strapi, {
      productId: product.id, fromColorId: red.id, toColorId: blue.id, dryRun: true,
    });
    expect(preview.emptyDrafts).toEqual([]);
    expect(preview.blocking.map((entry) => entry.id)).toEqual([orderedDraft.id]);
  });

  it("creates a new colour only once, and reuses an identical one", async () => {
    const red = await createColor(uniq("red"), "#ff0000");
    const s = await createSize(uniq("S"));
    const first = await createProduct();
    const second = await createProduct();
    const firstS = await createVariation({ productId: first.id, colorId: red.id, sizeId: s.id });
    const secondS = await createVariation({ productId: second.id, colorId: red.id, sizeId: s.id });
    const title = uniq("crimson");

    const created = await replaceProductVariationColor(strapi, {
      productId: first.id, fromColorId: red.id, newColor: { title, colorCode: "#E0115F" },
    });
    expect(created.targetColor.created).toBe(true);
    f.remember(COLOR, created.targetColor.id!);
    expect(await strapi.db.query(COLOR).findOne({ where: { id: created.targetColor.id } })).toMatchObject({
      Title: title,
      ColorCode: "#e0115f",
    });
    expect((await readVariation(firstS.id)).product_variation_color.id).toBe(created.targetColor.id);

    const reused = await replaceProductVariationColor(strapi, {
      productId: second.id, fromColorId: red.id, newColor: { title, colorCode: "e0115f" },
    });
    expect(reused.targetColor).toMatchObject({ id: created.targetColor.id, created: false });
    expect(await strapi.db.query(COLOR).count({ where: { Title: title } })).toBe(1);
    expect((await readVariation(secondS.id)).product_variation_color.id).toBe(created.targetColor.id);
  });

  it("reuses a colourless match by name", async () => {
    const red = await createColor(uniq("red"), "#ff0000");
    const plain = await createColor(uniq("plain"), null);
    const s = await createSize(uniq("S"));
    const product = await createProduct();
    await createVariation({ productId: product.id, colorId: red.id, sizeId: s.id });

    const preview = await replaceProductVariationColor(strapi, {
      productId: product.id, fromColorId: red.id, newColor: { title: plain.Title, colorCode: null }, dryRun: true,
    });
    expect(preview.targetColor).toMatchObject({ id: plain.id, created: false });
  });
});
