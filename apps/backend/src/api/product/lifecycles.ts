import { afterCatalogCommit, runCatalogSystemMutation } from "../../utils/catalogEdit";

import { refreshProductKeywords } from "./services/product-title-keywords-refresh";
async function refreshKeywordsAfterCommit() {
  await afterCatalogCommit(strapi, async () => {
    try {
      await refreshProductKeywords(strapi);
    } catch (error) {
      strapi.log.error("Product keywords refresh after save failed", error);
    }
  });
}
export default {
  models: ["api::product.product"],

  async afterCreate(event, ctx) {
    const { result } = event;

    const product = await strapi.entityService.findOne("api::product.product", result.id, {
      populate: ["product_size_helper"],
    });

    if (!product.product_size_helper) {
      const createHelper = () =>
        strapi.entityService.create("api::product-size-helper.product-size-helper", {
          data: {
            product: result.id,
            Helper: {},
          },
        });
      if (strapi.requestContext?.get()?.state?.user) {
        // This initial child belongs only to the row just created. Reuse the
        // enclosing product-creation transaction and the usual ownership guard;
        // subsequent HTTP child writes still require their edit lease.
        await runCatalogSystemMutation(strapi, [result.id], "catalog-initialization", createHelper);
      } else {
        await createHelper();
      }
    }
    await refreshKeywordsAfterCommit();
  },
  async afterUpdate(event) {
    if (typeof event.params?.data?.Title !== "string") {
      return;
    }

    await refreshKeywordsAfterCommit();
  },
};
