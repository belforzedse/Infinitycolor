import type { Strapi } from "@strapi/strapi";
import { randomUUID } from "node:crypto";
import { resolveCurrentAuditContext, writeAuditEvent } from "../../../audit/writer";
import { productLifecycleState, type ProductPublicationStatus } from "../../../utils/productVisibility";
import { getProductAvailabilityJoinContext } from "../../../utils/productAvailability";
import {
  enqueueScheduledProductPublication,
  removeScheduledProductPublication,
} from "../../../queue/product-publication-queue";
import {
  BUSINESS_TIMEZONE,
  PRODUCT_UID,
  PublicationCommandError,
  assertActiveSlugAvailable,
  executePublicationCommand,
  isoOrNull,
  publicationJobContext,
  publicationParties,
  runPublicationEffects,
  runPublicationEffectsBatch,
  type PublicationActor,
  type PublicationCommandContext,
} from "./product-publication";
import { LifecycleTransitionError, resolveRowTransition } from "./product-lifecycle-rules";

/**
 * Trash, restore and permanent deletion of products.
 *
 * Deletion is a lifecycle separate from publication:
 *  - Trash (`removed_at`) hides a product from every storefront surface at once
 *    (all public reads require `removed_at IS NULL`, see utils/productVisibility.ts),
 *    demotes it to draft, retires any schedule and remembers what it left.
 *  - Restore always lands on draft. Only the bounded Undo that follows a trash
 *    by the same person may put it straight back where it was.
 *  - Permanent deletion keeps the row as a tombstone (`purged_at`): order items
 *    reach products through variations, and Anipo shipping and the sales reports
 *    read variation → product, so a real delete would orphan history. It frees
 *    the product's identifiers (variation SKUs, external ids, slug aliases) for
 *    reuse; order items carry their own SKU/title snapshot. Media is never
 *    deleted — nothing can prove a file unreferenced (rich text embeds URLs and
 *    the media library shares files between products).
 *
 * Every transition takes the row lock (`SELECT … FOR UPDATE`), re-reads the
 * state and consults the shared transition matrix inside one transaction, so
 * concurrent admins, the publication scheduler and the retention job serialise
 * on the row and the later one sees the earlier one's result.
 */

export const UNDO_WINDOW_MS = 2 * 60 * 1000;
/** An undone schedule must still be comfortably in the future to be kept. */
export const UNDO_SCHEDULE_MIN_LEAD_MS = 60 * 1000;
export const MAX_BULK_PRODUCTS = 100;
export const EMPTY_TRASH_BATCH_LIMIT = 500;
const SKU_MAX_LENGTH = 255;

export type LifecycleOrigin = PublicationCommandContext["origin"];

export type LifecycleActor = PublicationActor & { label?: string | null };

export type LifecycleContext = {
  origin: LifecycleOrigin;
  actor?: LifecycleActor;
  now?: Date;
  /** Shared by every item of one bulk request, for audit correlation. */
  batchId?: string;
};

export type RestoreWarning =
  | "UNDO_EXPIRED"
  | "UNDO_PUBLISH_NOT_ALLOWED"
  | "UNDO_SCHEDULE_NOT_ALLOWED"
  | "SCHEDULE_EXPIRED"
  | "SLUG_IN_USE"
  | "MAIN_CATEGORY_MISSING"
  | "COVER_IMAGE_MISSING"
  | "NO_PUBLISHABLE_VARIATION"
  | "SKU_CONFLICT";

export type LifecycleResult = {
  productId: number;
  changed: boolean;
  state: ReturnType<typeof productLifecycleState>;
  status: ProductPublicationStatus;
  removedAt: string | null;
  previousStatus?: ProductPublicationStatus | null;
  warnings?: RestoreWarning[];
  /** Internal hand-off to the post-commit step; never sent to clients. */
  followUp?: {
    needsPublicationEffects: boolean;
    publicationRevision: number;
    removeScheduleRevision?: number;
    enqueueSchedule?: { scheduleRevision: number; expectedPublishAt: string };
  };
};

type ProductRow = {
  id: number;
  title: string | null;
  slug: string | null;
  status: ProductPublicationStatus | null;
  removed_at: string | Date | null;
  removed_by_id: number | null;
  removed_by_label: string | null;
  pre_removal_status: ProductPublicationStatus | null;
  pre_removal_scheduled_publish_at: string | Date | null;
  purged_at: string | Date | null;
  external_source: string | null;
  external_id: string | null;
  scheduled_publish_at: string | Date | null;
  scheduled_publish_revision: number | null;
  publication_revision: number | null;
  published_at: string | Date | null;
};

const productTable = (trx: any) => trx("products");

function statusOf(row: Pick<ProductRow, "status">): ProductPublicationStatus {
  return row.status === "Active" || row.status === "Scheduled" ? row.status : "InActive";
}

/** Legacy trashed rows predate `pre_removal_status`; their Status was never demoted. */
export function previousStatusOf(row: Pick<ProductRow, "pre_removal_status" | "status">) {
  return (row.pre_removal_status || statusOf(row)) as ProductPublicationStatus;
}

function toTransitionError(error: unknown): never {
  if (error instanceof LifecycleTransitionError) {
    throw new PublicationCommandError(error.code, error.status);
  }
  throw error;
}

function resolveOrThrow(row: ProductRow, command: Parameters<typeof resolveRowTransition>[1]) {
  try {
    return resolveRowTransition(row, command);
  } catch (error) {
    return toTransitionError(error);
  }
}

function assertProductId(productId: number): void {
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new PublicationCommandError("PRODUCT_ID_INVALID", 400);
  }
}

async function lockProduct(trx: any, productId: number): Promise<ProductRow> {
  const row = (await productTable(trx).where({ id: productId }).forUpdate().first()) as
    | ProductRow
    | undefined;
  if (!row) throw new PublicationCommandError("PRODUCT_NOT_FOUND", 404);
  return row;
}

function resultFromRow(row: ProductRow, changed: boolean): LifecycleResult {
  return {
    productId: Number(row.id),
    changed,
    state: productLifecycleState(row),
    status: statusOf(row),
    removedAt: isoOrNull(row.removed_at),
  };
}

function joinTable(
  strapi: Strapi,
  uid: string,
  attribute: string,
  fallback: { table: string; joinColumn: string; inverseColumn: string },
) {
  const joinTableMeta = (strapi as any)?.db?.metadata?.get?.(uid)?.attributes?.[attribute]?.joinTable;
  return {
    table: joinTableMeta?.name || fallback.table,
    joinColumn: joinTableMeta?.joinColumn?.name || fallback.joinColumn,
    inverseColumn: joinTableMeta?.inverseJoinColumn?.name || fallback.inverseColumn,
  };
}

async function writeLifecycleAudit(
  strapi: Strapi,
  trx: any,
  input: {
    eventKey: "products.trashed" | "products.restored" | "products.permanently_deleted";
    context: LifecycleContext;
    before: ProductRow;
    after: Partial<ProductRow>;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const ambient = resolveCurrentAuditContext();
  const parties = publicationParties(input.context);
  const eventId = randomUUID();
  await writeAuditEvent(
    strapi,
    {
      eventId,
      eventKey: input.eventKey,
      result: "success",
      initiator: parties.initiator,
      actor: parties.actor,
      origin: parties.origin,
      target: {
        type: "product",
        id: input.before.id,
        label: input.before.title || `Product ${input.before.id}`,
        snapshot: { title: input.before.title, slug: input.before.slug },
      },
      changes: [
        { field: "status", label: "وضعیت انتشار", from: input.before.status, to: input.after.status },
        {
          field: "removedAt",
          label: "سطل زباله",
          from: isoOrNull(input.before.removed_at),
          to: isoOrNull(input.after.removed_at),
        },
      ],
      metadata: input.metadata,
      batchId: input.context.batchId || null,
      requestId: ambient?.requestId,
      interactionId: ambient?.interactionId,
      correlationId: ambient?.correlationId || eventId,
      rootEventId: eventId,
      ip: input.context.actor?.ip,
      userAgent: input.context.actor?.userAgent,
      dedupeKey: `${input.eventKey}:${input.before.id}:${
        ambient?.interactionId || ambient?.requestId || eventId
      }`,
    },
    { trx },
  );
}

const LOG_ACTIONS = {
  trash: { action: "Trash", description: "Product moved to Trash" },
  restore: { action: "Restore", description: "Product restored from Trash" },
  purge: { action: "PermanentDelete", description: "Product permanently deleted (tombstone)" },
} as const;

/** The technical product-log row, written after commit like the publication log. */
async function writeLifecycleLog(
  strapi: Strapi,
  productId: number,
  kind: keyof typeof LOG_ACTIONS,
  context: LifecycleContext,
  changes: Record<string, unknown>,
): Promise<void> {
  const actor = context.actor;
  try {
    await strapi.entityService.create("api::product-log.product-log" as any, {
      data: {
        product: productId,
        ...(actor?.id ? { performed_by: actor.id } : {}),
        PerformedBy: actor?.label || actor?.name || context.origin,
        IP: actor?.ip || undefined,
        UserAgent: actor?.userAgent || undefined,
        Action: LOG_ACTIONS[kind].action,
        Description: `${LOG_ACTIONS[kind].description} (${context.origin})`,
        Changes: { origin: context.origin, ...changes },
      } as never,
    });
  } catch (error) {
    strapi.log.error("[product-lifecycle] technical log write failed", {
      productId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Post-commit work: drop the retired delayed job, queue a restored schedule and
 * purge public caches. The database already holds the truth, so each step is
 * best effort here and repaired by the scheduled-publication reconciler
 * (missing jobs, stale revisions, pending effects) if it fails.
 */
export async function completeLifecycleFollowUp(
  strapi: Strapi,
  result: LifecycleResult,
  opts: { deferEffects?: boolean } = {},
): Promise<void> {
  const followUp = result.followUp;
  if (!followUp) return;
  if (followUp.removeScheduleRevision) {
    await removeScheduledProductPublication(result.productId, followUp.removeScheduleRevision);
  }
  if (followUp.enqueueSchedule) {
    try {
      await enqueueScheduledProductPublication({
        productId: result.productId,
        scheduleRevision: followUp.enqueueSchedule.scheduleRevision,
        expectedPublishAt: followUp.enqueueSchedule.expectedPublishAt,
      });
    } catch (error) {
      strapi.log.error("[product-lifecycle] restored schedule enqueue failed; reconciler will repair", {
        productId: result.productId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (followUp.needsPublicationEffects && !opts.deferEffects) {
    try {
      await runPublicationEffects(strapi, result.productId, followUp.publicationRevision);
    } catch {
      // Recorded on the row; the reconciler retries it within a minute.
    }
  }
}

function actorLabel(actor?: LifecycleActor): string | null {
  const label = String(actor?.label || actor?.name || "").trim();
  return label ? label.slice(0, 255) : null;
}

/* ------------------------------------------------------------------ trash */

export async function trashProduct(
  strapi: Strapi,
  productId: number,
  context: LifecycleContext,
): Promise<LifecycleResult> {
  const result = await trashProductInTransaction(strapi, productId, context);
  await completeLifecycleFollowUp(strapi, result);
  if (result.changed) {
    await writeLifecycleLog(strapi, productId, "trash", context, {
      previousStatus: result.previousStatus,
      removedAt: result.removedAt,
    });
  }
  return result;
}

export async function trashProductInTransaction(
  strapi: Strapi,
  productId: number,
  context: LifecycleContext,
): Promise<LifecycleResult> {
  assertProductId(productId);
  const now = context.now || new Date();
  return strapi.db.transaction(async ({ trx }: any) => {
    const row = await lockProduct(trx, productId);
    const transition = resolveOrThrow(row, "trash");
    if (transition.noop) return resultFromRow(row, false);

    const status = statusOf(row);
    const wasPublic = status === "Active";
    const wasScheduled = status === "Scheduled";
    const scheduleRevision = Number(row.scheduled_publish_revision || 0);
    const publicationRevision = Number(row.publication_revision || 0);
    const update = {
      removed_at: now,
      removed_by_id: context.actor?.id ?? null,
      removed_by_label: actorLabel(context.actor),
      pre_removal_status: status,
      pre_removal_scheduled_publish_at: wasScheduled ? row.scheduled_publish_at : null,
      // Demote as well as hide: every public read already requires
      // removed_at IS NULL, and a draft status keeps that true even for a query
      // that forgot it. The schedule is retired exactly as `cancel` retires it,
      // so its delayed job finds a stale revision and does nothing.
      status: "InActive",
      scheduled_publish_at: null,
      scheduled_publish_timezone: null,
      scheduled_publish_revision: wasScheduled ? scheduleRevision + 1 : scheduleRevision,
      scheduled_publish_require_media: false,
      scheduled_publish_last_attempt_at: null,
      scheduled_publish_last_error: null,
      scheduled_publish_failure_kind: null,
      scheduled_publish_attempt_count: 0,
      scheduled_publish_next_retry_at: null,
      scheduled_publish_audit_context: null,
      // Leaving the storefront is a public visibility change: bumping the
      // revision makes the publication effects (cache purge, storefront
      // revalidation) durable through the reconciler.
      publication_revision: wasPublic ? publicationRevision + 1 : publicationRevision,
      ...(wasPublic ? { publication_effects_last_error: null } : {}),
      updated_at: now,
    };
    await productTable(trx).where({ id: productId }).update(update);

    await writeLifecycleAudit(strapi, trx, {
      eventKey: "products.trashed",
      context,
      before: row,
      after: { status: "InActive", removed_at: now },
      metadata: {
        previousStatus: status,
        previousScheduledPublishAt: wasScheduled ? isoOrNull(row.scheduled_publish_at) : null,
        scheduleRevision,
      },
    });

    return {
      productId,
      changed: true,
      state: "trashed",
      status: "InActive",
      removedAt: now.toISOString(),
      previousStatus: status,
      followUp: {
        needsPublicationEffects: wasPublic,
        publicationRevision: update.publication_revision,
        removeScheduleRevision: wasScheduled ? scheduleRevision : undefined,
      },
    } satisfies LifecycleResult;
  });
}

/* ---------------------------------------------------------------- restore */

export type RestoreOptions = {
  /** The `removedAt` a trash call returned; asks for the bounded Undo. */
  undoToken?: string | null;
  canPublish?: boolean;
  canSchedule?: boolean;
};

export type RestoreDecision = {
  target: "draft" | "published" | "scheduled";
  undo: boolean;
  publishAt?: string;
  warnings: RestoreWarning[];
};

/**
 * Where a restore lands. Plain restore → draft, always: nothing becomes public
 * again without someone deciding so. Undo — the same person, within the window,
 * holding the token of this very trash — reverses the trash itself, so a
 * published product is published again and a schedule still ahead is kept.
 * Anything short of that degrades to draft with a warning instead of failing.
 */
export function decideRestoreTarget(
  row: Pick<
    ProductRow,
    "removed_at" | "removed_by_id" | "pre_removal_status" | "status" | "pre_removal_scheduled_publish_at"
  >,
  input: RestoreOptions & { actorId?: number | null; now: Date },
): RestoreDecision {
  const warnings: RestoreWarning[] = [];
  if (!input.undoToken) return { target: "draft", undo: false, warnings };

  const removedAt = isoOrNull(row.removed_at);
  const tokenAt = isoOrNull(input.undoToken);
  const sameTrash = Boolean(removedAt && tokenAt && removedAt === tokenAt);
  const sameActor =
    Number.isSafeInteger(Number(input.actorId)) &&
    Number(input.actorId) > 0 &&
    Number(row.removed_by_id) === Number(input.actorId);
  const withinWindow =
    Boolean(removedAt) && input.now.getTime() - Date.parse(removedAt as string) <= UNDO_WINDOW_MS;
  if (!sameTrash || !sameActor || !withinWindow) {
    return { target: "draft", undo: false, warnings: ["UNDO_EXPIRED"] };
  }

  const previous = previousStatusOf(row);
  if (previous === "Active") {
    if (input.canPublish) return { target: "published", undo: true, warnings };
    return { target: "draft", undo: true, warnings: ["UNDO_PUBLISH_NOT_ALLOWED"] };
  }
  if (previous === "Scheduled") {
    const publishAt = isoOrNull(row.pre_removal_scheduled_publish_at);
    if (!input.canSchedule) {
      return { target: "draft", undo: true, warnings: ["UNDO_SCHEDULE_NOT_ALLOWED"] };
    }
    if (!publishAt || Date.parse(publishAt) <= input.now.getTime() + UNDO_SCHEDULE_MIN_LEAD_MS) {
      // Never silently run an expired schedule on the way back.
      return { target: "draft", undo: true, warnings: ["SCHEDULE_EXPIRED"] };
    }
    return { target: "scheduled", undo: true, publishAt, warnings };
  }
  return { target: "draft", undo: true, warnings };
}

/**
 * Things an admin should fix before publishing a restored product. None blocks
 * the restore itself: restore lands on draft, which is always safe.
 */
async function collectRestoreWarnings(
  strapi: Strapi,
  trx: any,
  row: ProductRow,
): Promise<RestoreWarning[]> {
  const warnings: RestoreWarning[] = [];
  const slug = String(row.slug || "").trim();
  if (slug) {
    const holder = await trx("products")
      .select("id")
      .where({ slug, status: "Active" })
      .whereNull("removed_at")
      .whereNot("id", row.id)
      .first();
    if (holder) warnings.push("SLUG_IN_USE");
  }

  const category = joinTable(strapi, PRODUCT_UID, "product_main_category", {
    table: "products_product_main_category_links",
    joinColumn: "product_id",
    inverseColumn: "product_category_id",
  });
  const categoryLink = await trx(category.table)
    .select(category.inverseColumn)
    .where(category.joinColumn, row.id)
    .first();
  if (!categoryLink) warnings.push("MAIN_CATEGORY_MISSING");

  const cover = await trx("files_related_morphs")
    .select("id")
    .where({ related_id: row.id, related_type: PRODUCT_UID, field: "CoverImage" })
    .first();
  if (!cover) warnings.push("COVER_IMAGE_MISSING");

  const joins = getProductAvailabilityJoinContext(strapi);
  const variationIds = (
    (await trx(joins.productVariationProductLinkTable)
      .select(joins.productVariationProductJoinColumn)
      .where(joins.productVariationProductInverseColumn, row.id)) as Array<Record<string, unknown>>
  ).map((link) => Number(link[joins.productVariationProductJoinColumn]));
  if (variationIds.length === 0) {
    warnings.push("NO_PUBLISHABLE_VARIATION");
    return warnings;
  }
  const priced = await trx("product_variations")
    .select("id")
    .whereIn("id", variationIds)
    .whereRaw("COALESCE(price, 0)::numeric > 0")
    .first();
  if (!priced) warnings.push("NO_PUBLISHABLE_VARIATION");

  // SKUs stay reserved while a product sits in Trash, so this only finds
  // duplicates written around the validator (legacy imports, direct SQL).
  const clash = await trx("product_variations as own")
    .join("product_variations as other", "other.sku", "own.sku")
    .whereIn("own.id", variationIds)
    .whereNotIn("other.id", variationIds)
    .whereNotNull("own.sku")
    .select("own.id")
    .first();
  if (clash) warnings.push("SKU_CONFLICT");
  return warnings;
}

export async function restoreProduct(
  strapi: Strapi,
  productId: number,
  context: LifecycleContext,
  options: RestoreOptions = {},
): Promise<LifecycleResult> {
  const result = await restoreProductInTransaction(strapi, productId, context, options);
  await completeLifecycleFollowUp(strapi, result);
  if (result.changed) {
    await writeLifecycleLog(strapi, productId, "restore", context, {
      restoredTo: result.status,
      previousStatus: result.previousStatus,
      warnings: result.warnings,
    });
  }
  return result;
}

export async function restoreProductInTransaction(
  strapi: Strapi,
  productId: number,
  context: LifecycleContext,
  options: RestoreOptions = {},
): Promise<LifecycleResult> {
  assertProductId(productId);
  const now = context.now || new Date();
  const auditEventId = randomUUID();
  return strapi.db.transaction(async ({ trx }: any) => {
    const row = await lockProduct(trx, productId);
    resolveOrThrow(row, "restore");

    const decision = decideRestoreTarget(row, {
      ...options,
      actorId: context.actor?.id ?? null,
      now,
    });
    const warnings: RestoreWarning[] = [...decision.warnings];
    let target = decision.target;

    if (target === "published") {
      try {
        await assertActiveSlugAvailable(trx, row);
        if (!String(row.title || "").trim() || !String(row.slug || "").trim()) {
          target = "draft";
        }
      } catch (error) {
        if (!(error instanceof PublicationCommandError)) throw error;
        // Undo must not fail outright because a new product took the slug;
        // it lands on draft and the warning below says why.
        target = "draft";
      }
    }

    const scheduleRevision = Number(row.scheduled_publish_revision || 0);
    const publicationRevision = Number(row.publication_revision || 0);
    const base = {
      removed_at: null,
      removed_by_id: null,
      removed_by_label: null,
      pre_removal_status: null,
      pre_removal_scheduled_publish_at: null,
      updated_at: now,
      ...(context.origin === "admin" ? { last_edited_by_admin_at: now } : {}),
    };
    let update: Record<string, unknown>;
    let followUp: LifecycleResult["followUp"] = {
      needsPublicationEffects: false,
      publicationRevision,
    };
    if (target === "published") {
      update = {
        ...base,
        status: "Active",
        publication_revision: publicationRevision + 1,
        publication_effects_last_error: null,
        published_at: row.published_at ?? now,
      };
      followUp = { needsPublicationEffects: true, publicationRevision: publicationRevision + 1 };
    } else if (target === "scheduled") {
      const nextRevision = scheduleRevision + 1;
      update = {
        ...base,
        status: "Scheduled",
        scheduled_publish_at: new Date(decision.publishAt as string),
        scheduled_publish_timezone: BUSINESS_TIMEZONE,
        scheduled_publish_revision: nextRevision,
        scheduled_publish_require_media: false,
        scheduled_publish_last_attempt_at: null,
        scheduled_publish_last_error: null,
        scheduled_publish_failure_kind: null,
        scheduled_publish_attempt_count: 0,
        scheduled_publish_next_retry_at: null,
        scheduled_publish_audit_context: publicationJobContext(context, auditEventId),
      };
      followUp = {
        needsPublicationEffects: false,
        publicationRevision,
        enqueueSchedule: {
          scheduleRevision: nextRevision,
          expectedPublishAt: decision.publishAt as string,
        },
      };
    } else {
      // Legacy trashed rows (and rollbacks) can still carry Active/Scheduled.
      // A plain restore always lands on draft, and any schedule they carried is
      // retired so its job finds a stale revision.
      const carriedSchedule = row.status === "Scheduled";
      update = {
        ...base,
        status: "InActive",
        scheduled_publish_at: null,
        scheduled_publish_timezone: null,
        scheduled_publish_revision: carriedSchedule ? scheduleRevision + 1 : scheduleRevision,
        scheduled_publish_audit_context: null,
      };
      if (carriedSchedule) followUp.removeScheduleRevision = scheduleRevision;
    }
    await productTable(trx).where({ id: productId }).update(update);

    const restoredRow = { ...row, ...update } as ProductRow;
    warnings.push(...(await collectRestoreWarnings(strapi, trx, restoredRow)));
    const uniqueWarnings = [...new Set(warnings)];

    await writeLifecycleAudit(strapi, trx, {
      eventKey: "products.restored",
      context,
      before: row,
      after: { status: update.status as ProductPublicationStatus, removed_at: null },
      metadata: {
        restoredTo: update.status,
        previousStatus: previousStatusOf(row),
        previousScheduledPublishAt: isoOrNull(row.pre_removal_scheduled_publish_at),
        trashedAt: isoOrNull(row.removed_at),
        trashedBy: row.removed_by_id ?? null,
        undo: decision.undo,
        warnings: uniqueWarnings,
      },
    });

    return {
      productId,
      changed: true,
      state: productLifecycleState(restoredRow),
      status: update.status as ProductPublicationStatus,
      removedAt: null,
      previousStatus: previousStatusOf(row),
      warnings: uniqueWarnings,
      followUp,
    } satisfies LifecycleResult;
  });
}

/* ------------------------------------------------------------------ purge */

/** `ABC-1` → `ABC-1~purged-42`, trimmed so the result still fits varchar(255). */
export function purgedSku(sku: string, productId: number): string {
  const suffix = `~purged-${productId}`;
  return `${sku.slice(0, SKU_MAX_LENGTH - suffix.length)}${suffix}`;
}

export async function purgeProduct(
  strapi: Strapi,
  productId: number,
  context: LifecycleContext,
): Promise<LifecycleResult> {
  const result = await purgeProductInTransaction(strapi, productId, context);
  if (result.changed) {
    await writeLifecycleLog(strapi, productId, "purge", context, { purgedAt: new Date().toISOString() });
  }
  return result;
}

export async function purgeProductInTransaction(
  strapi: Strapi,
  productId: number,
  context: LifecycleContext,
  opts: { trashedBefore?: Date } = {},
): Promise<LifecycleResult> {
  assertProductId(productId);
  const now = context.now || new Date();
  return strapi.db.transaction(async ({ trx }: any) => {
    const row = await lockProduct(trx, productId);
    const transition = resolveOrThrow(row, "purge");
    if (transition.noop) return resultFromRow(row, false);
    // The retention job and Empty Trash pass the cut-off they selected with;
    // re-checking it under the lock means a product restored and trashed again
    // in the meantime is not swept on its old eligibility.
    if (opts.trashedBefore && Date.parse(String(isoOrNull(row.removed_at))) > opts.trashedBefore.getTime()) {
      return resultFromRow(row, false);
    }

    const joins = getProductAvailabilityJoinContext(strapi);
    const variationIds = (
      (await trx(joins.productVariationProductLinkTable)
        .select(joins.productVariationProductJoinColumn)
        .where(joins.productVariationProductInverseColumn, productId)) as Array<Record<string, unknown>>
    )
      .map((link) => Number(link[joins.productVariationProductJoinColumn]))
      .filter((id) => Number.isSafeInteger(id) && id > 0);

    const variations = variationIds.length
      ? ((await trx("product_variations")
          .select("id", "sku", "external_id")
          .whereIn("id", variationIds)) as Array<{ id: number; sku: string | null; external_id: string | null }>)
      : [];
    for (const variation of variations) {
      await trx("product_variations")
        .where({ id: variation.id })
        .update({
          sku: variation.sku ? purgedSku(variation.sku, productId) : variation.sku,
          external_id: null,
          updated_at: now,
        });
    }

    const alias = joinTable(strapi, "api::product-slug-alias.product-slug-alias", "product", {
      table: "product_slug_aliases_product_links",
      joinColumn: "product_slug_alias_id",
      inverseColumn: "product_id",
    });
    const aliasIds = (
      (await trx(alias.table).select(alias.joinColumn).where(alias.inverseColumn, productId)) as Array<
        Record<string, unknown>
      >
    ).map((link) => Number(link[alias.joinColumn]));
    const aliasSlugs = aliasIds.length
      ? ((await trx("product_slug_aliases").select("slug").whereIn("id", aliasIds)) as Array<{ slug: string }>).map(
          (entry) => entry.slug,
        )
      : [];
    if (aliasIds.length) {
      await trx(alias.table).whereIn(alias.joinColumn, aliasIds).delete();
      await trx("product_slug_aliases").whereIn("id", aliasIds).delete();
    }

    await productTable(trx).where({ id: productId }).update({
      purged_at: now,
      purged_by_id: context.actor?.id ?? null,
      external_id: null,
      updated_at: now,
    });

    await writeLifecycleAudit(strapi, trx, {
      eventKey: "products.permanently_deleted",
      context,
      before: row,
      after: { status: row.status, removed_at: row.removed_at },
      metadata: {
        tombstone: true,
        previousStatus: previousStatusOf(row),
        trashedAt: isoOrNull(row.removed_at),
        trashedBy: row.removed_by_id ?? null,
        freedExternalId: row.external_id
          ? { source: row.external_source, id: row.external_id }
          : null,
        freedSkus: variations
          .filter((variation) => variation.sku)
          .map((variation) => ({ variationId: variation.id, sku: variation.sku })),
        freedVariationExternalIds: variations
          .filter((variation) => variation.external_id)
          .map((variation) => ({ variationId: variation.id, externalId: variation.external_id })),
        freedSlugAliases: aliasSlugs,
      },
    });

    return {
      ...resultFromRow({ ...row, purged_at: now } as ProductRow, true),
      state: "purged",
    } satisfies LifecycleResult;
  });
}

/* ------------------------------------------------------------------- bulk */

export type BulkLifecycleAction = "publish" | "unpublish" | "schedule" | "trash" | "restore" | "purge";

export const BULK_ACTION_CAPABILITY: Record<BulkLifecycleAction, string> = {
  publish: "product.publish",
  unpublish: "product.publish",
  schedule: "product.schedule",
  trash: "product.softDelete",
  restore: "product.restore",
  purge: "product.delete",
};

export type BulkLifecycleResult = {
  action: BulkLifecycleAction;
  succeeded: number[];
  unchanged: number[];
  failed: Array<{ id: number; code: string }>;
  warnings: Array<{ id: number; warnings: RestoreWarning[] }>;
};

export function parseBulkProductIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PublicationCommandError("BULK_IDS_REQUIRED", 400);
  }
  const ids = [...new Set(raw.map((value) => Number(value)))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new PublicationCommandError("PRODUCT_ID_INVALID", 400);
  }
  if (ids.length > MAX_BULK_PRODUCTS) {
    throw new PublicationCommandError("BULK_LIMIT_EXCEEDED", 400);
  }
  return ids;
}

const PUBLICATION_BULK_ACTIONS: Partial<Record<BulkLifecycleAction, "publish-now" | "unpublish" | "schedule">> = {
  publish: "publish-now",
  unpublish: "unpublish",
  schedule: "schedule",
};

/**
 * One server-side pass over a selection. Each product is its own transaction —
 * a refusal (wrong state, slug conflict) never undoes the rest — and the result
 * says exactly which ids changed, which were already there and which failed
 * with which code. Cache effects are batched after the loop.
 */
export async function runLifecycleBulk(
  strapi: Strapi,
  action: BulkLifecycleAction,
  productIds: number[],
  context: LifecycleContext,
  input: { publishAt?: string; timezone?: string } = {},
): Promise<BulkLifecycleResult> {
  const batchId = context.batchId || randomUUID();
  const itemContext: LifecycleContext = { ...context, batchId };
  const summary: BulkLifecycleResult = { action, succeeded: [], unchanged: [], failed: [], warnings: [] };
  const effects: number[] = [];

  await writeBulkAudit(strapi, "products.bulk_requested", action, productIds.length, itemContext, summary);

  for (const productId of productIds) {
    try {
      const publicationAction = PUBLICATION_BULK_ACTIONS[action];
      if (publicationAction) {
        const result = await executePublicationCommand(
          strapi,
          productId,
          {
            action: publicationAction,
            ...(publicationAction === "schedule"
              ? { publishAt: input.publishAt, timezone: input.timezone || BUSINESS_TIMEZONE }
              : {}),
          },
          { origin: itemContext.origin, actor: itemContext.actor, now: itemContext.now },
        );
        if (publicationAction === "schedule" && result.changed && result.scheduledPublishAt) {
          try {
            await enqueueScheduledProductPublication({
              productId,
              scheduleRevision: result.scheduleRevision,
              expectedPublishAt: result.scheduledPublishAt,
              auditContext: result.auditJobContext,
            });
          } catch (error) {
            strapi.log.error("[product-lifecycle] bulk schedule enqueue failed; reconciler will repair", {
              productId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (result.previousScheduleRevision) {
          await removeScheduledProductPublication(productId, result.previousScheduleRevision);
        }
        if (result.needsPublicationEffects) effects.push(productId);
        (result.changed ? summary.succeeded : summary.unchanged).push(productId);
        continue;
      }

      const result =
        action === "trash"
          ? await trashProductInTransaction(strapi, productId, itemContext)
          : action === "restore"
            ? await restoreProductInTransaction(strapi, productId, itemContext)
            : await purgeProductInTransaction(strapi, productId, itemContext);
      await completeLifecycleFollowUp(strapi, result, { deferEffects: true });
      if (result.followUp?.needsPublicationEffects) effects.push(productId);
      if (result.warnings?.length) summary.warnings.push({ id: productId, warnings: result.warnings });
      (result.changed ? summary.succeeded : summary.unchanged).push(productId);
      if (result.changed) {
        await writeLifecycleLog(strapi, productId, action as "trash" | "restore" | "purge", itemContext, {
          batchId,
        });
      }
    } catch (error) {
      if (error instanceof PublicationCommandError) {
        summary.failed.push({ id: productId, code: error.code });
        continue;
      }
      strapi.log.error("[product-lifecycle] bulk item failed", {
        productId,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
      summary.failed.push({ id: productId, code: "LIFECYCLE_COMMAND_FAILED" });
    }
  }

  if (effects.length) await runPublicationEffectsBatch(strapi, effects);
  await writeBulkAudit(strapi, "products.bulk_completed", action, productIds.length, itemContext, summary);
  strapi.log.info("[product-lifecycle] bulk command completed", {
    action,
    requested: productIds.length,
    succeeded: summary.succeeded.length,
    unchanged: summary.unchanged.length,
    failed: summary.failed.length,
    batchId,
  });
  return summary;
}

async function writeBulkAudit(
  strapi: Strapi,
  eventKey: "products.bulk_requested" | "products.bulk_completed",
  action: BulkLifecycleAction,
  requested: number,
  context: LifecycleContext,
  summary: BulkLifecycleResult,
): Promise<void> {
  const parties = publicationParties(context);
  try {
    await writeAuditEvent(strapi, {
      eventKey,
      result: eventKey === "products.bulk_completed" && summary.failed.length ? "partial" : "success",
      initiator: parties.initiator,
      actor: parties.actor,
      origin: parties.origin,
      target: { type: "product_batch", id: context.batchId || null, label: `${requested} products` },
      metadata: {
        action,
        requested,
        ...(eventKey === "products.bulk_completed"
          ? {
              succeeded: summary.succeeded.length,
              unchanged: summary.unchanged.length,
              failed: summary.failed,
            }
          : {}),
      },
      batchId: context.batchId || null,
      ip: context.actor?.ip,
      userAgent: context.actor?.userAgent,
      dedupeKey: `${eventKey}:${context.batchId}`,
    });
  } catch (error) {
    // The per-product events inside each transaction are the authoritative
    // record; a failed batch envelope must not fail the command.
    strapi.log.error("[product-lifecycle] bulk audit envelope failed", {
      eventKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ------------------------------------------------------------ empty trash */

/**
 * Permanently deletes what is in Trash, oldest first, at most `limit` per call.
 * `trashedBefore` is the moment the admin looked at the list: a product someone
 * else trashed after that is not swept up without being seen. The caller loops
 * while `remaining > 0` and the previous batch purged something.
 */
export async function emptyTrash(
  strapi: Strapi,
  context: LifecycleContext,
  input: { trashedBefore: Date; limit?: number },
): Promise<{ purged: number; failed: number; remaining: number }> {
  const limit = Math.min(Math.max(1, input.limit ?? EMPTY_TRASH_BATCH_LIMIT), EMPTY_TRASH_BATCH_LIMIT);
  const batchId = context.batchId || randomUUID();
  const ids = await selectTrashedIds(strapi, input.trashedBefore, limit);
  let purged = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const result = await purgeProductInTransaction(strapi, id, { ...context, batchId }, {
        trashedBefore: input.trashedBefore,
      });
      if (result.changed) purged += 1;
    } catch (error) {
      failed += 1;
      strapi.log.error("[product-lifecycle] empty trash item failed", {
        productId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const remaining = await countTrashed(strapi, input.trashedBefore);
  strapi.log.info("[product-lifecycle] empty trash batch", { purged, failed, remaining, batchId });
  // A caller keeps going only while a batch made progress, so an item that
  // keeps failing can never spin the loop.
  return { purged, failed, remaining };
}

function trashedBeforeQuery(strapi: Strapi, trashedBefore: Date) {
  return strapi.db
    .connection("products")
    .whereNotNull("removed_at")
    .whereNull("purged_at")
    .where("removed_at", "<=", trashedBefore);
}

async function selectTrashedIds(strapi: Strapi, trashedBefore: Date, limit: number): Promise<number[]> {
  const rows = (await trashedBeforeQuery(strapi, trashedBefore)
    .select("id")
    .orderBy([{ column: "removed_at", order: "asc" }, { column: "id", order: "asc" }])
    .limit(limit)) as Array<{ id: number }>;
  return rows.map((row) => Number(row.id));
}

async function countTrashed(strapi: Strapi, trashedBefore: Date): Promise<number> {
  const row = (await trashedBeforeQuery(strapi, trashedBefore).count({ count: "id" }).first()) as
    | { count: string | number }
    | undefined;
  return Number(row?.count || 0);
}
