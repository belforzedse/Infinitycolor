import type { Strapi } from "@strapi/strapi";
import type { Context } from "koa";
import { readProductKeywords } from "../services/product-title-keywords";
import { waitForProductKeywordsRefresh } from "../services/product-title-keywords-refresh";
export default ({ strapi }: { strapi: Strapi }) => ({
  async index(ctx: Context) {
    await waitForProductKeywordsRefresh(strapi).catch(() => undefined);
    const keywords = await readProductKeywords(strapi);

    ctx.set("Cache-Control", "private, no-store");

    ctx.body = {
      data: {
        keywords,
      },
    };
  },
});
