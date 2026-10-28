import type { Strapi } from "@strapi/strapi";
import type { Context } from "koa";
import { readProductKeywords } from "../services/product-title-keywords";

export default ({ strapi }: { strapi: Strapi }) => ({
  async index(ctx: Context) {
    const keywords = await readProductKeywords(strapi);

    ctx.set("Cache-Control", "private, no-store");

    ctx.body = {
      data: {
        keywords,
      },
    };
  },
});
