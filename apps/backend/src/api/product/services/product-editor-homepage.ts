import { CatalogEditError, afterCatalogCommit, catalogMutationContext, withHomepageSettingsWrite } from "../../../utils/catalogEdit";
import { clearAllProductCaches } from "../../../utils/productOriginCache";
import { writeAuditEvent } from "../../../audit/writer";

const UID = "api::settings.settings";
const FIELDS = ["homeNewestProductIds", "homeFavoriteProductIds", "homeDiscountedProductIds"];

export async function saveEditorHomepage(strapi: any, productId: number, input: any) {
  const context = catalogMutationContext();
  if (!context?.ids.includes(productId)) throw new CatalogEditError("CATALOG_GUARD_REQUIRED", 500);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !FIELDS.includes(key) || typeof input[key] !== "boolean")) throw new CatalogEditError("HOMEPAGE_PAYLOAD_INVALID", 400);
  const initial = await strapi.db.query(UID).findOne({ where: {}, orderBy: { id: "asc" } });
  if (!initial) throw new CatalogEditError("SETTINGS_NOT_FOUND", 404);
  await context.trx("settings").where({ id: initial.id }).forUpdate().first();
  const current = await strapi.db.query(UID).findOne({ where: { id: initial.id } });
  const data: Record<string, unknown> = {};
  for (const field of Object.keys(input)) {
    const ids: number[] = Array.isArray(current[field]) ? current[field] : [];
    if (ids.includes(productId) === input[field]) continue;
    const without = ids.filter((id) => id !== productId);
    const updated = input[field] ? [productId, ...without] : without;
    if (updated.length > 100) throw new CatalogEditError("HOMEPAGE_PRODUCT_LIMIT", 400);
    data[field] = updated;
  }
  if (Object.keys(data).length) {
    data.HomepageProductsRevision = Number(current.HomepageProductsRevision || 0) + 1;
    await withHomepageSettingsWrite(() => strapi.entityService.update(UID, current.id, { data }));
    await writeAuditEvent(strapi, { eventKey: "content.changed", target: { type: "settings", id: current.id }, metadata: { productId, changedFields: Object.keys(data).filter((key) => key !== "HomepageProductsRevision") } }, { trx: context.trx });
    await afterCatalogCommit(strapi, () => clearAllProductCaches(strapi, "editor-homepage"));
  }
  const updated = await strapi.db.query(UID).findOne({ where: { id: current.id } });
  return { id: updated.id, attributes: Object.fromEntries([
    ...[...FIELDS, "homeWeeklyPicksProductIds", "homeEveryoneFollowsProductIds"].map((field) => [field, updated[field] || []]),
    ...["homeWeeklyPicksEnabled", "homeEveryoneFollowsEnabled"].map((field) => [field, Boolean(updated[field])]),
    ["HomepageProductsRevision", Number(updated.HomepageProductsRevision || 0)],
  ]) };
}
