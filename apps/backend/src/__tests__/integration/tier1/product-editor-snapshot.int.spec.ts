import { randomUUID } from "node:crypto";
import { loadEditorSnapshot } from "../../../api/product/services/product-editor-snapshot";
import { makeFactories, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;
let fixtures: Factories;
let attributeId: number;
let termId: number;

beforeAll(async () => { strapi = await setupStrapi(); });
afterAll(async () => { await teardownStrapi(); });
beforeEach(() => { fixtures = makeFactories(strapi); });
afterEach(async () => {
  await fixtures.cleanup();
  if (termId) await strapi.entityService.delete("api::product-attribute-term.product-attribute-term", termId);
  if (attributeId) await strapi.entityService.delete("api::product-attribute.product-attribute", attributeId);
});

it("returns the parent attribute of selected terms so generic-only variation labels survive editor hydration", async () => {
  const product = await fixtures.createProduct();
  const variation = await fixtures.createVariation({ productId: product.id, stockCount: 3 });
  const attribute = await strapi.entityService.create("api::product-attribute.product-attribute", {
    data: { Title: "کد رنگ", Slug: `color-code-${randomUUID()}`, Scope: "Global", Type: "Text", LegacyProjection: "None" },
  });
  attributeId = attribute.id;
  const term = await strapi.entityService.create("api::product-attribute-term.product-attribute-term", {
    data: { Title: "کد 13", product_attribute: attribute.id },
  });
  termId = term.id;
  await strapi.entityService.update("api::product-variation.product-variation", variation.id, {
    data: {
      product_variation_color: null, product_variation_size: null, product_variation_model: null,
      selected_attribute_terms: [term.id],
    },
  });

  const snapshot = await loadEditorSnapshot(strapi, product.id);
  const row = snapshot.product.attributes.product_variations.data.find((item: any) => item.id === variation.id);
  const selected = row.attributes.selected_attribute_terms.data;
  expect(selected).toHaveLength(1);
  expect(selected[0].attributes.product_attribute).toMatchObject({
    data: { id: attribute.id, attributes: { Title: "کد رنگ" } },
  });
  expect(selected[0]).toMatchObject({ id: term.id, attributes: { Title: "کد 13" } });
  expect(row.attributes.product_stock.data.attributes.Count).toBe(3);
});
