/**
 * The one business rule for "may the storefront show and sell this product".
 *
 * A product is public when it is published (`Status = Active`) and not in Trash
 * (`removedAt IS NULL`). Permanently deleted products are tombstones that keep
 * `removedAt` set, so the same rule hides them too. Draft (`InActive`) and
 * `Scheduled` products are never public: a schedule only becomes public when the
 * scheduler flips the row to `Active`, so there is no time comparison to get
 * wrong here and a scheduled product cannot leak early.
 *
 * Variation-level sellability (published, priced, in stock) is a separate rule in
 * `productAvailability.ts`; it narrows this one and never widens it.
 *
 * Keep every storefront query, cart check and feed on these helpers instead of
 * restating the two conditions inline.
 */

export const PUBLIC_PRODUCT_STATUS = "Active" as const;

export type ProductPublicationStatus = "Active" | "InActive" | "Scheduled";

/** A fresh entity-service / query-engine filter. Callers may mutate the result. */
export function publicProductFilters(): { Status: "Active"; removedAt: { $null: true } } {
  return { Status: PUBLIC_PRODUCT_STATUS, removedAt: { $null: true } };
}

/**
 * Filter for catalog reads. Staff see drafts and scheduled products but never
 * trashed ones through catalog surfaces; everyone else sees only public products.
 */
export function catalogProductFilters(includeUnpublished: boolean): Record<string, unknown> {
  return includeUnpublished ? { removedAt: { $null: true } } : publicProductFilters();
}

/** Knex `where` for a raw `products` query, optionally aliased. */
export function wherePublicProduct<T extends { where: Function; whereNull: Function }>(
  query: T,
  alias?: string,
): T {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return query.where(column("status"), PUBLIC_PRODUCT_STATUS).whereNull(column("removed_at")) as T;
}

/**
 * The same rule as a SQL fragment for hand-written statements. The alias is a
 * compile-time identifier, never request input.
 */
export function publicProductSql(alias = "p"): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error("publicProductSql alias must be a plain identifier");
  }
  return `${alias}.status = '${PUBLIC_PRODUCT_STATUS}' AND ${alias}.removed_at IS NULL`;
}

type ProductLike =
  | {
      Status?: unknown;
      status?: unknown;
      removedAt?: unknown;
      removed_at?: unknown;
      purgedAt?: unknown;
      purged_at?: unknown;
      attributes?: ProductLike;
    }
  | null
  | undefined;

function read(product: ProductLike, camel: string, snake: string): unknown {
  if (!product) return undefined;
  const source = product.attributes && typeof product.attributes === "object"
    ? product.attributes
    : product;
  const record = source as Record<string, unknown>;
  return record[camel] !== undefined ? record[camel] : record[snake];
}

export function productStatusOf(product: ProductLike): ProductPublicationStatus {
  const status = read(product, "Status", "status");
  return status === "Active" || status === "Scheduled" ? status : "InActive";
}

export function isProductRemoved(product: ProductLike): boolean {
  return Boolean(read(product, "removedAt", "removed_at"));
}

export function isProductPurged(product: ProductLike): boolean {
  return Boolean(read(product, "purgedAt", "purged_at"));
}

/** Works for entity-service rows, REST `{ id, attributes }` shapes and raw snake_case rows. */
export function isProductPubliclyVisible(product: ProductLike): boolean {
  if (!product) return false;
  return read(product, "Status", "status") === PUBLIC_PRODUCT_STATUS && !isProductRemoved(product);
}

/**
 * Why a product the shopper holds is no longer sellable, using the codes the
 * order path has always thrown (`lib/order.ts`). `null` means it is public.
 */
export function productUnavailableReason(
  product: ProductLike,
): null | "PRODUCT_NOT_FOUND" | "PRODUCT_DELETED" | "PRODUCT_INACTIVE" {
  if (!product) return "PRODUCT_NOT_FOUND";
  if (isProductRemoved(product)) return "PRODUCT_DELETED";
  if (read(product, "Status", "status") !== PUBLIC_PRODUCT_STATUS) return "PRODUCT_INACTIVE";
  return null;
}

export type ProductLifecycleState = "purged" | "trashed" | "published" | "scheduled" | "draft";

/**
 * Publication and deletion are separate dimensions; this folds them into the one
 * state the admin lists and the transition matrix reason about. Deletion wins:
 * a trashed row is "trashed" whatever Status it still carries (legacy rows and
 * rollbacks can leave `Active` on a trashed product).
 */
export function productLifecycleState(product: ProductLike): ProductLifecycleState {
  if (isProductPurged(product)) return "purged";
  if (isProductRemoved(product)) return "trashed";
  const status = productStatusOf(product);
  if (status === "Active") return "published";
  if (status === "Scheduled") return "scheduled";
  return "draft";
}
