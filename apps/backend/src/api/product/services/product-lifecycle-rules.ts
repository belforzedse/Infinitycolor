import {
  productLifecycleState,
  type ProductLifecycleState,
} from "../../../utils/productVisibility";

/**
 * The product lifecycle transition matrix — the single place that decides which
 * command may run from which state. `product-publication.ts` (publish, schedule,
 * move to draft) and `product-lifecycle.ts` (trash, restore, permanent delete)
 * both consult it inside their row-locked transactions, so a stale admin screen
 * or a concurrent command can never push a product into an impossible state.
 *
 * The admin app mirrors this table to decide which actions to offer
 * (`apps/admin/src/components/SuperAdmin/Product/list/productLifecycle.ts`);
 * the server remains the authority.
 */

export type ProductLifecycleCommand =
  | "publish"
  | "schedule"
  | "unpublish"
  | "trash"
  | "restore"
  | "purge";

export type LifecycleRefusal = {
  code:
    | "PRODUCT_REMOVED"
    | "PRODUCT_PURGED"
    | "PRODUCT_NOT_IN_TRASH"
    | "SCHEDULED_UPDATE_UNSUPPORTED";
  status: number;
};

type Outcome = ProductLifecycleState | "noop" | LifecycleRefusal;

const REMOVED: LifecycleRefusal = { code: "PRODUCT_REMOVED", status: 422 };
const PURGED: LifecycleRefusal = { code: "PRODUCT_PURGED", status: 409 };
const NOT_IN_TRASH: LifecycleRefusal = { code: "PRODUCT_NOT_IN_TRASH", status: 409 };
const PUBLISHED_SCHEDULE: LifecycleRefusal = { code: "SCHEDULED_UPDATE_UNSUPPORTED", status: 409 };

/**
 * `noop` marks an idempotent repeat (publishing a published product, trashing a
 * trashed one): the command succeeds without writing, so double clicks and
 * retried bulk items are harmless. Trash can only be left through restore,
 * which always lands on draft — never directly on published.
 */
export const LIFECYCLE_TRANSITIONS: Record<
  ProductLifecycleState,
  Record<ProductLifecycleCommand, Outcome>
> = {
  draft: {
    publish: "published",
    schedule: "scheduled",
    unpublish: "noop",
    trash: "trashed",
    restore: NOT_IN_TRASH,
    purge: NOT_IN_TRASH,
  },
  scheduled: {
    publish: "published",
    schedule: "scheduled",
    unpublish: "draft",
    trash: "trashed",
    restore: NOT_IN_TRASH,
    purge: NOT_IN_TRASH,
  },
  published: {
    publish: "noop",
    schedule: PUBLISHED_SCHEDULE,
    unpublish: "draft",
    trash: "trashed",
    restore: NOT_IN_TRASH,
    purge: NOT_IN_TRASH,
  },
  trashed: {
    publish: REMOVED,
    schedule: REMOVED,
    unpublish: REMOVED,
    trash: "noop",
    restore: "draft",
    purge: "purged",
  },
  purged: {
    publish: PURGED,
    schedule: PURGED,
    unpublish: PURGED,
    trash: PURGED,
    restore: PURGED,
    purge: "noop",
  },
};

export class LifecycleTransitionError extends Error {
  code: LifecycleRefusal["code"];
  status: number;

  constructor(refusal: LifecycleRefusal) {
    super(refusal.code);
    this.name = "LifecycleTransitionError";
    this.code = refusal.code;
    this.status = refusal.status;
  }
}

export type ResolvedTransition = {
  from: ProductLifecycleState;
  to: ProductLifecycleState;
  noop: boolean;
};

export function resolveLifecycleTransition(
  from: ProductLifecycleState,
  command: ProductLifecycleCommand,
): ResolvedTransition {
  const outcome = LIFECYCLE_TRANSITIONS[from][command];
  if (typeof outcome === "object") throw new LifecycleTransitionError(outcome);
  if (outcome === "noop") return { from, to: from, noop: true };
  return { from, to: outcome, noop: false };
}

/** Convenience for a raw `products` row (snake_case) or an entity. */
export function resolveRowTransition(
  row: Parameters<typeof productLifecycleState>[0],
  command: ProductLifecycleCommand,
): ResolvedTransition {
  return resolveLifecycleTransition(productLifecycleState(row), command);
}
