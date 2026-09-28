import { hasCapability, normalizeAdminRole } from "@repo/auth-core";
import { isTrustedWordPressMigrationRequest } from "../utils/migration-context";
import { publicProductFilters } from "../utils/productVisibility";

/**
 * Keeps unpublished products out of the public catalog's satellite endpoints.
 *
 * The public role may `find`/`findOne` product variations, reviews, FAQs, size
 * helpers, attribute assignments, attributes, categories and tags, and any of
 * those can populate their product relation — which would hand out drafts,
 * scheduled and trashed products that the product routes themselves hide.
 * This route middleware applies the canonical visibility rule
 * (utils/productVisibility.ts) there too:
 *
 *  - `owner` types belong to one product (`product`): public callers only see
 *    entries whose product is public, on lists and single reads alike.
 *  - `strip` types reference many products (`products`, `product_others`,
 *    `owner_product`): public callers cannot populate or filter by them.
 *
 * Only a signed-in staff member holding `product.read` (or a trusted migration
 * request) sees past it, so the admin keeps editing drafts through these same
 * routes. API tokens get the public view — the same rule the product routes
 * apply (`applyPublicProductFilters`) — because a server-side token such as the
 * storefront's is not a staff member.
 */

type OwnerConfig = { mode: "owner"; uid: string; relation?: string };
type StripConfig = { mode: "strip"; uid: string; relations: string[] };
export type PublicProductVisibilityConfig = OwnerConfig | StripConfig;

function callerSeesUnpublished(ctx: any): boolean {
  if (isTrustedWordPressMigrationRequest()) return true;
  const user = ctx?.state?.user;
  if (!user) return false;
  const role = normalizeAdminRole(user?.role?.type) ?? normalizeAdminRole(user?.role?.name);
  return role ? hasCapability(role, "product.read") : false;
}

function andFilters(existing: unknown, extra: Record<string, unknown>) {
  if (!existing || (typeof existing === "object" && Object.keys(existing as object).length === 0)) {
    return extra;
  }
  return { $and: [existing, extra] };
}

/** Removes every filter clause that walks into one of `relations`, at any depth. */
export function stripRelationFilters(filters: unknown, relations: Set<string>): unknown {
  if (Array.isArray(filters)) {
    return filters.map((entry) => stripRelationFilters(entry, relations));
  }
  if (!filters || typeof filters !== "object") return filters;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
    if (relations.has(key)) continue;
    out[key] = stripRelationFilters(value, relations);
  }
  return out;
}

/**
 * Rewrites `populate` so none of `relations` is populated. `*` is expanded to
 * the content type's other populatable attributes rather than dropped.
 */
export function stripRelationPopulate(
  populate: unknown,
  relations: Set<string>,
  populatable: string[],
): unknown {
  if (populate === undefined || populate === null || populate === "") return populate;
  if (populate === "*" || populate === true || populate === "true") {
    return populatable.filter((name) => !relations.has(name));
  }
  if (typeof populate === "string") {
    return populate
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry && !relations.has(entry.split(".")[0]))
      .join(",");
  }
  if (Array.isArray(populate)) {
    return populate.filter(
      (entry) => typeof entry !== "string" || !relations.has(entry.split(".")[0]),
    );
  }
  if (typeof populate === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(populate as Record<string, unknown>)) {
      if (!relations.has(key)) out[key] = value;
    }
    return out;
  }
  return populate;
}

function populatableAttributes(strapi: any, uid: string): string[] {
  const attributes = strapi?.contentType?.(uid)?.attributes || {};
  return Object.entries(attributes)
    .filter(([, attribute]: [string, any]) =>
      ["relation", "media", "component", "dynamiczone"].includes(attribute?.type),
    )
    .map(([name]) => name);
}

export default (config: PublicProductVisibilityConfig, { strapi }: { strapi: any }) =>
  async (ctx: any, next: () => Promise<unknown>) => {
    if (!config?.uid || callerSeesUnpublished(ctx)) return next();

    const query = { ...(ctx.query || {}) };

    if (config.mode === "owner") {
      const relation = config.relation || "product";
      const visibleOwner = { [relation]: publicProductFilters() };
      const id = ctx.params?.id;
      if (id !== undefined) {
        // findOne ignores `filters`; check the owner directly.
        const entry = await strapi.db.query(config.uid).findOne({
          where: { id, ...visibleOwner },
          select: ["id"],
        });
        if (!entry) return ctx.notFound();
      }
      query.filters = andFilters(query.filters, visibleOwner);
      ctx.query = query;
      return next();
    }

    const relations = new Set(config.relations);
    query.populate = stripRelationPopulate(
      query.populate,
      relations,
      populatableAttributes(strapi, config.uid),
    );
    if (query.filters) query.filters = stripRelationFilters(query.filters, relations);
    ctx.query = query;
    return next();
  };
