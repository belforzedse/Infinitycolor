/**
 * The Newest listing (`/offer?type=newest` and the homepage rail) on real Postgres.
 *
 * The ranking, the discount/Oppsi exclusion and the pagination are one raw SQL statement, so the
 * order is proven against the database rather than against the builder calls: curated
 * picks first in their exact admin order, then in-stock products newest listing first,
 * then out-of-stock ones, with no duplicates, gaps or ties left to chance.
 */
import {
  findOrderedProductIds,
  NEWEST_OFFER,
} from "../../../api/product/services/product-card-query";
import { makeFactories, TEST_PREFIX, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;
let f: Factories;
const createdFiles: number[] = [];
const createdGeneralDiscounts: number[] = [];

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.parse("2026-09-01T12:00:00.000Z");
const at = (daysAgo: number) => new Date(BASE - daysAgo * DAY).toISOString();

// Every title carries the run token and every query filters on it, so products left by
// other specs in the shared database can never enter the ordering under test.
const token = `${TEST_PREFIX}NEWEST${Date.now()}`;

type Fixture = { id: number; inStock: boolean; listedAt: string };
const fx: Record<string, Fixture> = {};

async function createCover(productId: number) {
  const name = `${token}_${productId}.webp`;
  const file = await strapi.db.query("plugin::upload.file").create({
    data: {
      name,
      hash: name.replace(/\W/g, "_"),
      ext: ".webp",
      mime: "image/webp",
      size: 10,
      width: 800,
      height: 1000,
      url: `/uploads/${name}`,
      provider: "local",
    },
  });
  createdFiles.push(file.id);
  await strapi.db.connection("files_related_morphs").insert({
    file_id: file.id,
    related_id: productId,
    related_type: "api::product.product",
    field: "CoverImage",
    order: 1,
  });
}

async function createGeneralDiscount(variationId: number, opts: { removed?: boolean } = {}) {
  const row = await strapi.db.query("api::general-discount.general-discount").create({
    data: {
      Type: "Discount",
      Amount: 10,
      StartDate: at(30),
      EndDate: at(-30),
      IsActive: true,
      product_variations: [variationId],
      ...(opts.removed ? { removedAt: at(1) } : {}),
    },
  });
  createdGeneralDiscounts.push(row.id);
}

async function product(
  key: string,
  opts: {
    title?: string;
    createdDaysAgo: number;
    publishedDaysAgo?: number;
    // Admin activity long after listing: the old ranking's key, which Newest must ignore.
    editedDaysAgo?: number;
    inStock?: boolean;
    discountPrice?: number;
    generalDiscount?: "live" | "removed";
    status?: "Active" | "InActive";
    cover?: boolean;
    publishedVariation?: boolean;
  },
) {
  const inStock = opts.inStock ?? true;
  const row = await f.createProduct({
    title: `${token} ${opts.title ?? key}`,
    status: opts.status ?? "Active",
  });
  const variation = await f.createVariation({
    productId: row.id,
    price: 100000,
    discountPrice: opts.discountPrice ?? null,
    stockCount: inStock ? 5 : 0,
    isPublished: opts.publishedVariation ?? true,
  });
  if (opts.generalDiscount) {
    await createGeneralDiscount(variation.id, { removed: opts.generalDiscount === "removed" });
  }
  if (opts.cover ?? true) await createCover(row.id);

  const createdAt = at(opts.createdDaysAgo);
  const publishedAt = opts.publishedDaysAgo !== undefined ? at(opts.publishedDaysAgo) : null;
  // ISO strings with `Z`, not Date objects: node-pg would render a Date in the runner's
  // local zone, which `timestamp without time zone` would then store as wall time.
  await strapi.db
    .connection("products")
    .where({ id: row.id })
    .update({
      created_at: createdAt,
      published_at: publishedAt,
      last_edited_by_admin_at: at(opts.editedDaysAgo ?? opts.publishedDaysAgo ?? opts.createdDaysAgo),
    });

  fx[key] = { id: row.id, inStock, listedAt: publishedAt ?? createdAt };
  return row.id;
}

const ids = (...keys: string[]) => keys.map((key) => fx[key].id);
const scoped = { Title: { $containsi: token } };

async function newest(params: Record<string, unknown> = {}) {
  return findOrderedProductIds(strapi, {
    offer: NEWEST_OFFER,
    filters: scoped,
    pagination: { page: 1, pageSize: 100 },
    ...params,
  });
}

let manualSetting: number[];
let expectedDefault: number[];
let settingsId: number;
let originalNewestIds: unknown;
let createdSettings = false;

beforeAll(async () => {
  strapi = await setupStrapi();
  f = makeFactories(strapi);

  // Curated picks, deliberately not in date order. m3 is out of stock and keeps its slot.
  await product("m1", { createdDaysAgo: 40 });
  await product("m2", { createdDaysAgo: 2.5 });
  await product("m3", { createdDaysAgo: 20, inStock: false });
  await product("m4", { createdDaysAgo: 60 });
  await product("m5", { createdDaysAgo: 0.2 });
  await product("m6", { createdDaysAgo: 10 });
  // Curated references that must vanish without leaving a hole.
  await product("mDraft", { createdDaysAgo: 1, status: "InActive" });
  await product("mTrashed", { createdDaysAgo: 1 });
  await strapi.db
    .connection("products")
    .where({ id: fx.mTrashed.id })
    .update({ removed_at: at(0.5) });
  // Curated but discounted or Oppsi: Newest shows neither, whoever picked it.
  await product("mOppsi", { title: "مانتو OPPSI curated", createdDaysAgo: 1, discountPrice: 70000 });
  await product("mDiscounted", { createdDaysAgo: 1, discountPrice: 60000 });
  await product("mOppsiPlain", { title: "OPPSI curated full price", createdDaysAgo: 1 });

  // Automatic bucket.
  await product("a1", { createdDaysAgo: 1 });
  await product("a2", { createdDaysAgo: 2 });
  await product("a3", { createdDaysAgo: 2 }); // identical instant to a2: id breaks the tie
  await product("a4", { createdDaysAgo: 3, discountPrice: 80000 }); // discounted: excluded
  await product("a5", { title: "Oppsi without discount", createdDaysAgo: 4 }); // Oppsi: excluded
  await product("o1", { title: "foo oppsi bar full price", createdDaysAgo: 0.3 }); // Oppsi: excluded
  // Created long ago but first published recently: listed by its go-live moment.
  await product("a6", { createdDaysAgo: 100, publishedDaysAgo: 0.5 });
  await product("a7", { createdDaysAgo: 0.1, inStock: false }); // newest, but out of stock
  await product("a8", { createdDaysAgo: 6, inStock: false });
  // Edited by an admin just now, listed 50 days ago: must not jump the queue.
  await product("a9", { createdDaysAgo: 50, editedDaysAgo: 0 });
  // A "discount" that is not one by the storefront rule does not exclude a product.
  await product("k1", { title: "price-not-lower", createdDaysAgo: 7, discountPrice: 100000 });
  await product("k2", { title: "zero-discount", createdDaysAgo: 8, discountPrice: 0 });
  await product("k3", { title: "removed-general", createdDaysAgo: 9, generalDiscount: "removed" });

  // Discounted products, Oppsi in any casing or not: all excluded.
  await product("x1", { title: "OPPSI upper", createdDaysAgo: 0.3, discountPrice: 90000 });
  await product("x2", { title: "oppsi lower", createdDaysAgo: 0.3, discountPrice: 90000 });
  await product("x3", { title: "Oppsi mixed", createdDaysAgo: 0.3, discountPrice: 90000 });
  await product("x4", { title: "foo oppsi bar", createdDaysAgo: 0.3, discountPrice: 90000 });
  await product("x5", { title: "کتونیOPPSI general", createdDaysAgo: 0.3, generalDiscount: "live" });

  // Not eligible for any storefront listing.
  await product("n1", { createdDaysAgo: 0.3, cover: false });
  await product("n2", { createdDaysAgo: 0.3, publishedVariation: false });

  manualSetting = [
    fx.m1.id,
    fx.mDraft.id,
    fx.m2.id,
    2_000_000_000, // never existed
    fx.m3.id,
    fx.mOppsi.id,
    fx.mDiscounted.id,
    fx.mOppsiPlain.id,
    fx.m4.id,
    fx.mTrashed.id,
    fx.m5.id,
    fx.m6.id,
  ];

  expectedDefault = [
    ...ids("m1", "m2", "m3", "m4", "m5", "m6"),
    ...ids("a6", "a1"),
    ...[fx.a2.id, fx.a3.id].sort((a, b) => b - a),
    ...ids("k1", "k2", "k3", "a9"),
    ...ids("a7", "a8"),
  ];

  // The single settings row is only seeded by the web bootstrap, which the test boot skips.
  const settings = await strapi.db.query("api::settings.settings").findOne();
  if (settings) {
    settingsId = settings.id;
    originalNewestIds = settings.homeNewestProductIds;
    await strapi.db.query("api::settings.settings").update({
      where: { id: settingsId },
      data: { homeNewestProductIds: manualSetting },
    });
  } else {
    const row = await strapi.db.query("api::settings.settings").create({
      data: { homeNewestProductIds: manualSetting },
    });
    settingsId = row.id;
    createdSettings = true;
  }
});

afterAll(async () => {
  try {
    if (createdSettings) {
      await strapi.db.query("api::settings.settings").delete({ where: { id: settingsId } });
    } else if (settingsId) {
      await strapi.db.query("api::settings.settings").update({
        where: { id: settingsId },
        data: { homeNewestProductIds: originalNewestIds ?? [] },
      });
    }
    const knex = strapi.db.connection;
    if (createdGeneralDiscounts.length) {
      await strapi.db
        .query("api::general-discount.general-discount")
        .deleteMany({ where: { id: { $in: createdGeneralDiscounts } } });
    }
    if (createdFiles.length) {
      await knex("files_related_morphs").whereIn("file_id", createdFiles).del();
      await knex("files").whereIn("id", createdFiles).del();
    }
    await f.cleanup();
  } finally {
    await teardownStrapi();
  }
});

describe("Newest listing (real Postgres)", () => {
  it("ranks curated picks first in admin order, then in-stock and out-of-stock by listing date", async () => {
    const { ids: ranked, pagination } = await newest({ curatedProductIds: manualSetting });

    expect(ranked).toEqual(expectedDefault);
    expect(pagination).toMatchObject({ total: expectedDefault.length, pageCount: 1 });
  });

  it("lists every product once", async () => {
    const { ids: ranked } = await newest({ curatedProductIds: manualSetting });
    expect(new Set(ranked).size).toBe(ranked.length);
  });

  it("excludes every discounted and every Oppsi product, curated or not, and keeps the rest", async () => {
    const { ids: ranked } = await newest({ curatedProductIds: manualSetting });

    for (const key of [
      "x1", "x2", "x3", "x4", "x5", // discounted Oppsi, any casing
      "a5", "o1", "mOppsiPlain", // Oppsi with no discount entered
      "a4", "mDiscounted", "mOppsi", // discounted, curated or not
    ]) {
      expect(ranked).not.toContain(fx[key].id);
    }
    // A DiscountPrice that isn't below Price, a zero one, or a removed general discount is
    // not a discount, so these stay.
    for (const key of ["k1", "k2", "k3"]) {
      expect(ranked).toContain(fx[key].id);
    }
    // Ineligible for every storefront listing, curated or not.
    for (const key of ["n1", "n2", "mDraft", "mTrashed"]) {
      expect(ranked).not.toContain(fx[key].id);
    }
  });

  it("pages across the curated/automatic boundary without duplicates or gaps", async () => {
    const pages: number[][] = [];
    for (let page = 1; page <= 4; page += 1) {
      const result = await newest({
        curatedProductIds: manualSetting,
        pagination: { page, pageSize: 4 },
      });
      expect(result.pagination).toMatchObject({ total: 16, pageCount: 4, pageSize: 4 });
      pages.push(result.ids);
    }

    expect(pages[0]).toEqual(ids("m1", "m2", "m3", "m4"));
    expect(pages[1]).toEqual(ids("m5", "m6", "a6", "a1"));
    expect(pages.flat()).toEqual(expectedDefault);
  });

  it("is plain newest-first when nothing is curated", async () => {
    const { ids: ranked } = await newest();

    const eligible = expectedDefault.map(
      (id) => Object.values(fx).find((fixture) => fixture.id === id)!,
    );
    const expected = [...eligible]
      .sort(
        (a, b) =>
          Number(b.inStock) - Number(a.inStock) ||
          Date.parse(b.listedAt) - Date.parse(a.listedAt) ||
          b.id - a.id,
      )
      .map((fixture) => fixture.id);
    expect(ranked).toEqual(expected);
  });

  it("keeps the curated block ahead when the shopper filters, dropping only what the filter drops", async () => {
    const { ids: ranked } = await newest({
      curatedProductIds: manualSetting,
      availability: "available",
    });
    expect(ranked).toEqual(expectedDefault.filter((id) => id !== fx.m3.id && id !== fx.a7.id && id !== fx.a8.id));
  });

  it("orders a shopper-picked sort over the same dataset without the curated block", async () => {
    const { ids: ranked } = await newest({ curatedProductIds: manualSetting, sort: ["price:asc"] });

    expect(new Set(ranked)).toEqual(new Set(expectedDefault));
    // Every remaining card sells at full price, so it is the plain PLP price order:
    // in stock first, equal prices by id ascending.
    const byId = (keys: string[]) => keys.map((key) => fx[key]).sort((a, b) => a.id - b.id);
    const kept = Object.keys(fx).filter((key) => expectedDefault.includes(fx[key].id));
    expect(ranked).toEqual([
      ...byId(kept.filter((key) => fx[key].inStock)).map((f) => f.id),
      ...byId(kept.filter((key) => !fx[key].inStock)).map((f) => f.id),
    ]);
  });

  it("serves the full service path in the same order, cards hydrated", async () => {
    const service = strapi.service("api::product.product");
    const page2 = await service.findProductCards({
      offer: "newest",
      filters: scoped,
      pagination: { page: 2, pageSize: 4 },
    });

    expect(page2.data.map((card: any) => card.id)).toEqual(ids("m5", "m6", "a6", "a1"));
    expect(page2.meta.pagination).toMatchObject({ total: 16, pageCount: 4 });
  });

  it("fills the homepage rail from the same ranking: curated in stock first, then the newest", async () => {
    const service = strapi.service("api::product.product");
    const sections = await service.findHomepageSections();
    const rail = sections.data.sections.find((section: any) => section.id === "newest");
    const railIds = rail.products.map((card: any) => card.id);

    const { ids: listing } = await findOrderedProductIds(strapi, {
      offer: NEWEST_OFFER,
      curatedProductIds: manualSetting,
      availability: "in-stock",
      pagination: { limit: 20, withCount: false },
    });

    expect(railIds.slice(0, 5)).toEqual(ids("m1", "m2", "m4", "m5", "m6"));
    expect(railIds).toEqual(listing);
    expect(rail.source).toBe("manual");
  });
});
