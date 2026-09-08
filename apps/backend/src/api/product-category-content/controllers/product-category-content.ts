import { factories } from "@strapi/strapi";

const UID = "api::product-category-content.product-category-content" as const;

function positiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function validationError(ctx: any, error: unknown) {
  const code = error instanceof Error ? error.message : "EDITORIAL_INVALID";
  const messages: Record<string, string> = {
    EDITORIAL_IMAGE_ALT_REQUIRED: "All editorial images require useful alternative text",
    EDITORIAL_TITLE_REQUIRED: "Editorial heading is required",
    EDITORIAL_PUBLISHED_CONTENT_REQUIRED:
      "Published editorial content requires an introduction or body",
  };
  return ctx.badRequest(messages[code] ?? "Invalid category editorial content", { code });
}

export default factories.createCoreController(UID, ({ strapi }) => ({
  async targets(ctx) {
    const page = positiveInt(ctx.query?.page, 1);
    const pageSize = positiveInt(ctx.query?.pageSize, 25, 100);
    const q = typeof ctx.query?.q === "string" ? ctx.query.q.trim().slice(0, 120) : "";
    ctx.body = await strapi.service(UID).listTargets({ page, pageSize, q });
  },

  async editable(ctx) {
    const categoryId = positiveInt(ctx.params?.categoryId, 0);
    if (!categoryId) return ctx.badRequest("Invalid category ID");
    const data = await strapi.service(UID).getEditable(categoryId);
    if (!data) return ctx.notFound("Category not found");
    ctx.body = { data };
  },

  async upsert(ctx) {
    const categoryId = positiveInt(ctx.params?.categoryId, 0);
    if (!categoryId) return ctx.badRequest("Invalid category ID");
    const requestBody = (ctx.request as any)?.body ?? {};
    const payload = requestBody.data ?? requestBody;
    try {
      const result = await strapi
        .service(UID)
        .upsert(categoryId, payload, requestBody.expectedUpdatedAt);
      if (result.kind === "not-found") return ctx.notFound("Category not found");
      if (result.kind === "conflict") {
        ctx.status = 409;
        ctx.body = {
          error: {
            status: 409,
            message: "Category editorial content changed",
            details: result.current,
          },
        };
        return;
      }
      ctx.body = { data: result.data, meta: { revalidationFailed: result.revalidationFailed } };
    } catch (error) {
      return validationError(ctx, error);
    }
  },

  async publicBySlug(ctx) {
    const rawSlug = typeof ctx.params?.slug === "string" ? ctx.params.slug : "";
    let slug = "";
    try {
      slug = decodeURIComponent(rawSlug).trim().slice(0, 240);
    } catch {
      return ctx.badRequest("Invalid category slug");
    }
    ctx.body = { data: slug ? await strapi.service(UID).getPublicBySlug(slug) : null };
  },
}));
