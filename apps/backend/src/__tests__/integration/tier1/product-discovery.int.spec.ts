import { createServer, type Server } from "node:http";
import { findOrderedProductIds } from "../../../api/product/services/product-card-query";
import { publicProductFilters } from "../../../utils/productVisibility";
import { makeFactories, TEST_PREFIX, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;
let f: Factories;
let settingsId: number;
let server: Server;
let origin: string;
let publicPermission: number | undefined;
let previous: any;
const token = `${TEST_PREFIX}DISCOVERY${Date.now()}`;
const settingsFields = [
  "homeNewestProductIds", "homeFavoriteProductIds", "homeDiscountedProductIds",
  "homeWeeklyPicksEnabled", "homeWeeklyPicksProductIds",
];

beforeAll(async () => {
  strapi = await setupStrapi();
  f = makeFactories(strapi);
  const role = await strapi.db.query("plugin::users-permissions.role").findOne({where: {type: "public"}});
  const permission = strapi.db.query("plugin::users-permissions.permission");
  const existing = await permission.findOne({where: {action: "api::product.product.find", role: role.id}});
  if (!existing) publicPermission = (await permission.create({data: {action: "api::product.product.find", role: role.id}})).id;
  strapi.server.mount();
  server = createServer(strapi.server.app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const settings = await strapi.db.query("api::settings.settings").findOne();
  if (settings) {
    settingsId = settings.id;
    previous = Object.fromEntries(settingsFields.map((key) => [key, settings[key]]));
  } else {
    settingsId = (await strapi.db.query("api::settings.settings").create({ data: {} })).id;
  }
}, 180_000);

afterAll(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (strapi) {
    if (publicPermission) await strapi.db.query("plugin::users-permissions.permission").delete({where: {id: publicPermission}});
    const query = strapi.db.query("api::settings.settings");
    if (previous) await query.update({ where: { id: settingsId }, data: previous });
    else if (settingsId) await query.delete({ where: { id: settingsId } });
    await f?.cleanup();
  }
  await teardownStrapi();
});

async function product(title: string, status: "Active" | "InActive" = "Active") {
  const row = await f.createProduct({ title: `${token} ${title}`, status });
  await f.createVariation({ productId: row.id, price: 100000, stockCount: 5 });
  return row;
}

it("excludes Oppsi from ordinary listings, search and curated cards, but keeps its own page and staff catalog", async () => {
  const normal = await product("مانتو");
  const oppsi = await product("مانتوOPPSI");
  const filters = { ...publicProductFilters(), Title: { $containsi: token } };
  const query = (extra: any = {}) => findOrderedProductIds(strapi, {
    filters, pagination: { pageSize: 100 }, ...extra,
  });
  expect((await query()).ids).toEqual([normal.id]);
  expect((await query({ curatedProductIds: [oppsi.id, normal.id], hasDiscount: false })).ids).toEqual([normal.id]);
  const onlyOppsi = await query({ oppsi: "true" });
  expect(onlyOppsi.ids).toEqual([oppsi.id]);
  expect(onlyOppsi.pagination.total).toBe(1);
  expect((await query({ isAdmin: true })).ids).toEqual(expect.arrayContaining([normal.id, oppsi.id]));
  const service = strapi.service("api::product.product");
  const search = await service.search(token, { view: "suggestion", pageSize: 100 });
  expect(search.results.map((row: any) => row.id)).toContain(normal.id);
  expect(search.results.map((row: any) => row.id)).not.toContain(oppsi.id);
  // Exercise the actual public collection contract used by card secondary media.
  const request = async (params: Record<string, string>) => {
    const response = await fetch(`${origin}/api/products?${new URLSearchParams(params)}`);
    expect(response.status).toBe(200);
    return await response.json() as any;
  };
  const ordinary = await request({"filters[Title][$containsi]": token});
  expect(ordinary.data.map((row: any) => row.id)).toEqual([normal.id]);
  const dedicated = await request({"filters[Title][$containsi]": token, view: "card", oppsi: "true"});
  expect(dedicated.data.map((row: any) => row.id)).toEqual([oppsi.id]);
  const identity = await request({"filters[id][$eq]": String(oppsi.id), "populate[Media][fields][0]": "url"});
  expect(identity.data).toEqual([expect.objectContaining({id: oppsi.id})]);
  const draft = await product("OPPSI unpublished", "InActive");
  expect((await request({"filters[id][$eq]": String(draft.id)})).data).toEqual([]);
});

it("retains pending homepage membership and displays the product after publication without saving the list again", async () => {
  const live = await product("آماده");
  const draft = await product("پیش‌نویس", "InActive");
  const oppsi = await product("OPPSI منتخب");
  const picked = [draft.id, oppsi.id, live.id];
  await strapi.db.query("api::settings.settings").update({ where: { id: settingsId }, data: {
    homeNewestProductIds: [], homeFavoriteProductIds: picked, homeDiscountedProductIds: picked,
    homeWeeklyPicksEnabled: true, homeWeeklyPicksProductIds: picked,
  } });
  const service = strapi.service("api::product.product");
  const ids = (result: any, section: string) => result.data.sections.find((s: any) => s.id === section).products.map((p: any) => p.id);
  const before = await service.findHomepageSections();
  for (const section of ["favorites", "discounted", "weeklyPicks"]) expect(ids(before, section)).toEqual([live.id]);
  await strapi.db.query("api::product.product").update({ where: { id: draft.id }, data: { Status: "Active" } });
  const after = await service.findHomepageSections();
  for (const section of ["favorites", "discounted", "weeklyPicks"]) expect(ids(after, section)).toEqual([draft.id, live.id]);
  const saved = await strapi.db.query("api::settings.settings").findOne({ where: { id: settingsId } });
  expect(saved.homeFavoriteProductIds).toEqual(picked);
  expect(saved.homeDiscountedProductIds).toEqual(picked);
});
