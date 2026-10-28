import {
  CART_INDEX_STATE_SQL,
  CART_ONE_PER_USER_INDEX,
  CART_ONE_PER_USER_INDEX_SQL,
  COUNT_USERS_WITH_SEVERAL_CARTS_SQL,
} from "./cart-database";

/**
 * Consolidates customers who own more than one cart, and (opt-in) re-attaches carts that
 * lost their owner link, then installs `idx_carts_one_per_user` — all in one transaction.
 *
 * Both shapes come from the post-login race fixed in `user-cart-identity.ts`: two carts
 * linked to one user (checkout read either), or the merged guest cart unlinked by a
 * concurrent create. The rules keep every legitimate line and never double one:
 *
 *  - The cart kept is the one `resolveUserCartId` already serves (`compareCartRank`), so
 *    a shopper's live cart id does not change under them.
 *  - A line whose variation the kept cart already has raises that line to the larger
 *    quantity (never the sum — in production every such pair was the shopper re-adding
 *    what had vanished) and stays behind in the retired cart.
 *  - Any other line moves, keeping its `cart_items.id`, so order cleanup that follows
 *    `order_items.source_cart_item_id` through `cart.user` still finds it.
 *  - A line whose variation the shopper has since ordered (non-cancelled order placed
 *    after the line) is left behind: that intent was fulfilled.
 *  - Retired carts are unlinked, not deleted; their remaining lines stay as history and
 *    the report lists every change so it can be reversed.
 *
 * An orphan (no owner link, still holding lines) is attributed only when exactly one
 * guest-merge record, belonging to exactly one user, was written within [-1s, +10s] of
 * the cart with an identical variation set, and that record matches no other orphan —
 * the merge creates the cart and writes its record in one transaction.
 */

export type RepairCart = {
  cartId: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  status: string | null;
};

export type RepairLink = RepairCart & { userId: number };

export type RepairLine = {
  cartItemId: number;
  cartId: number;
  variationId: number | null;
  count: number;
  sum: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  order: number | null;
};

export type RepairMergeCandidate = {
  orphanCartId: number;
  mergeRowId: number;
  userIds: number[];
  variationIds: number[];
};

export type RepairPurchase = { userId: number; variationId: number; orderedAt: Date };

export type RepairInput = {
  links: RepairLink[];
  orphans: RepairCart[];
  mergeCandidates: RepairMergeCandidate[];
  lines: RepairLine[];
  purchases: RepairPurchase[];
};

export type KeptReason =
  | "same_variation_in_kept_cart"
  | "bought_since"
  | "no_variation";

export type UserRepair = {
  userId: number;
  keptCartId: number;
  unlinkedCartIds: number[];
  recoveredOrphanCartIds: number[];
  /** Set when the user had no linked cart: this orphan is linked and becomes the kept cart. */
  linkedOrphanCartId: number | null;
  moved: Array<{ cartItemId: number; fromCartId: number; variationId: number; count: number; order: number }>;
  raised: Array<{
    cartItemId: number;
    variationId: number;
    fromCount: number;
    toCount: number;
    fromSum: number;
    toSum: number;
    sourceCartItemId: number;
  }>;
  left: Array<{ cartItemId: number; cartId: number; variationId: number | null; count: number; reason: KeptReason }>;
};

export type UnattributedOrphan = {
  cartId: number;
  reason:
    | "no_merge_in_window"
    | "variation_set_mismatch"
    | "several_matching_merges"
    | "merge_matches_several_orphans"
    | "line_without_variation";
  candidateUserIds: number[];
};

export type RepairPlan = {
  users: UserRepair[];
  unattributedOrphans: UnattributedOrphan[];
};

const time = (value: Date | null | undefined): number | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.getTime() : null;

const lastActivity = (cart: RepairCart, lines: RepairLine[]): number | null => {
  const stamps = [time(cart.updatedAt), ...lines.map((line) => time(line.updatedAt))].filter(
    (value): value is number => value !== null,
  );
  return stamps.length > 0 ? Math.max(...stamps) : null;
};

/**
 * Mirrors `LINKED_CARTS_RANKED_SQL` in `user-cart-identity.ts`: a cart with lines first,
 * then latest activity (carts or lines, missing timestamps last), then the lowest id.
 */
export const compareCartRank = (
  a: { cart: RepairCart; lines: RepairLine[] },
  b: { cart: RepairCart; lines: RepairLine[] },
): number => {
  const aHasLines = a.lines.length > 0 ? 1 : 0;
  const bHasLines = b.lines.length > 0 ? 1 : 0;
  if (aHasLines !== bHasLines) return bHasLines - aHasLines;
  const aSeen = lastActivity(a.cart, a.lines);
  const bSeen = lastActivity(b.cart, b.lines);
  if (aSeen !== bSeen) {
    if (aSeen === null) return 1;
    if (bSeen === null) return -1;
    return bSeen - aSeen;
  }
  return a.cart.cartId - b.cart.cartId;
};

const sameSet = (a: number[], b: number[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
};

const attributeOrphans = (input: RepairInput, linesByCart: Map<number, RepairLine[]>) => {
  const attributed = new Map<number, number>();
  const unattributed: UnattributedOrphan[] = [];
  const qualifying = new Map<number, RepairMergeCandidate>();
  const claimsPerMerge = new Map<number, number>();

  for (const orphan of input.orphans) {
    const lines = linesByCart.get(orphan.cartId) || [];
    const candidates = input.mergeCandidates.filter((row) => row.orphanCartId === orphan.cartId);
    const candidateUserIds = [...new Set(candidates.flatMap((row) => row.userIds))].sort((a, b) => a - b);

    if (lines.some((line) => line.variationId === null)) {
      unattributed.push({ cartId: orphan.cartId, reason: "line_without_variation", candidateUserIds });
      continue;
    }
    if (candidates.length === 0) {
      unattributed.push({ cartId: orphan.cartId, reason: "no_merge_in_window", candidateUserIds });
      continue;
    }
    const orphanVariations = lines.map((line) => line.variationId as number);
    const matching = candidates.filter(
      (row) => row.userIds.length === 1 && sameSet(row.variationIds, orphanVariations),
    );
    if (matching.length === 0) {
      unattributed.push({ cartId: orphan.cartId, reason: "variation_set_mismatch", candidateUserIds });
      continue;
    }
    if (matching.length > 1) {
      unattributed.push({ cartId: orphan.cartId, reason: "several_matching_merges", candidateUserIds });
      continue;
    }
    qualifying.set(orphan.cartId, matching[0]);
    claimsPerMerge.set(matching[0].mergeRowId, (claimsPerMerge.get(matching[0].mergeRowId) || 0) + 1);
  }

  for (const [orphanCartId, merge] of qualifying) {
    if ((claimsPerMerge.get(merge.mergeRowId) || 0) > 1) {
      unattributed.push({
        cartId: orphanCartId,
        reason: "merge_matches_several_orphans",
        candidateUserIds: merge.userIds,
      });
      continue;
    }
    attributed.set(orphanCartId, merge.userIds[0]);
  }

  unattributed.sort((a, b) => a.cartId - b.cartId);
  return { attributed, unattributed };
};

/**
 * Pure: decides every change without touching the database. Users are those with more
 * than one linked cart, plus owners of attributed orphans when `input.orphans` is given.
 */
export function planUserCartRepair(input: RepairInput): RepairPlan {
  const linesByCart = new Map<number, RepairLine[]>();
  for (const line of input.lines) {
    const list = linesByCart.get(line.cartId) || [];
    list.push(line);
    linesByCart.set(line.cartId, list);
  }
  const linesOf = (cartId: number) => linesByCart.get(cartId) || [];

  const { attributed, unattributed } = attributeOrphans(input, linesByCart);

  const linksByUser = new Map<number, RepairLink[]>();
  for (const link of input.links) {
    const list = linksByUser.get(link.userId) || [];
    list.push(link);
    linksByUser.set(link.userId, list);
  }
  const orphansByUser = new Map<number, RepairCart[]>();
  const orphanById = new Map(input.orphans.map((orphan) => [orphan.cartId, orphan]));
  for (const [orphanCartId, userId] of attributed) {
    const list = orphansByUser.get(userId) || [];
    list.push(orphanById.get(orphanCartId) as RepairCart);
    orphansByUser.set(userId, list);
  }

  const purchasesByUser = new Map<number, RepairPurchase[]>();
  for (const purchase of input.purchases) {
    const list = purchasesByUser.get(purchase.userId) || [];
    list.push(purchase);
    purchasesByUser.set(purchase.userId, list);
  }
  const boughtSince = (userId: number, line: RepairLine) => {
    const created = time(line.createdAt);
    return (purchasesByUser.get(userId) || []).some(
      (purchase) =>
        purchase.variationId === line.variationId &&
        (created === null || purchase.orderedAt.getTime() > created),
    );
  };

  const userIds = [
    ...new Set([
      ...[...linksByUser].filter(([, links]) => links.length > 1).map(([userId]) => userId),
      ...orphansByUser.keys(),
    ]),
  ].sort((a, b) => a - b);

  const users: UserRepair[] = [];
  for (const userId of userIds) {
    const ranked = (linksByUser.get(userId) || [])
      .map((cart) => ({ cart, lines: linesOf(cart.cartId) }))
      .sort(compareCartRank);
    const orphans = (orphansByUser.get(userId) || []).slice().sort((a, b) => a.cartId - b.cartId);

    let kept: RepairCart;
    let linkedOrphanCartId: number | null = null;
    const siblings: RepairCart[] = [];
    if (ranked.length > 0) {
      kept = ranked[0].cart;
      siblings.push(...ranked.slice(1).map((entry) => entry.cart));
    } else {
      kept = orphans[0];
      linkedOrphanCartId = kept.cartId;
    }
    const recoveredOrphans = orphans.filter((orphan) => orphan.cartId !== linkedOrphanCartId);
    siblings.push(...recoveredOrphans);

    const repair: UserRepair = {
      userId,
      keptCartId: kept.cartId,
      unlinkedCartIds: ranked.slice(1).map((entry) => entry.cart.cartId),
      recoveredOrphanCartIds: orphans.map((orphan) => orphan.cartId),
      linkedOrphanCartId,
      moved: [],
      raised: [],
      left: [],
    };

    // The kept cart's line per variation, and its planned quantity.
    const keptByVariation = new Map<number, { cartItemId: number; count: number; sum: number }>();
    let nextOrder = 0;
    for (const line of linesOf(kept.cartId).slice().sort((a, b) => a.cartItemId - b.cartItemId)) {
      nextOrder = Math.max(nextOrder, Number(line.order) || 0);
      if (line.variationId !== null && !keptByVariation.has(line.variationId)) {
        keptByVariation.set(line.variationId, { cartItemId: line.cartItemId, count: line.count, sum: line.sum });
      }
    }
    const originalKept = new Map(
      [...keptByVariation].map(([variationId, line]) => [variationId, { ...line }]),
    );

    // Largest quantity first, so the line that moves is the one carrying the most intent
    // and any same-variation line after it can only be equal or smaller.
    const siblingLines = siblings
      .flatMap((cart) => linesOf(cart.cartId))
      .sort(
        (a, b) =>
          b.count - a.count ||
          (time(b.updatedAt) ?? 0) - (time(a.updatedAt) ?? 0) ||
          a.cartItemId - b.cartItemId,
      );

    for (const line of siblingLines) {
      if (line.variationId === null) {
        repair.left.push({ ...pickLeft(line), reason: "no_variation" });
        continue;
      }
      if (boughtSince(userId, line)) {
        repair.left.push({ ...pickLeft(line), reason: "bought_since" });
        continue;
      }
      const target = keptByVariation.get(line.variationId);
      if (target) {
        if (line.count > target.count) {
          target.count = line.count;
          target.sum = line.sum;
          const existingRaise = repair.raised.find((raise) => raise.cartItemId === target.cartItemId);
          if (existingRaise) {
            existingRaise.toCount = line.count;
            existingRaise.toSum = line.sum;
            existingRaise.sourceCartItemId = line.cartItemId;
          } else {
            const original = originalKept.get(line.variationId);
            repair.raised.push({
              cartItemId: target.cartItemId,
              variationId: line.variationId,
              fromCount: original ? original.count : target.count,
              toCount: line.count,
              fromSum: original ? original.sum : target.sum,
              toSum: line.sum,
              sourceCartItemId: line.cartItemId,
            });
          }
        }
        repair.left.push({ ...pickLeft(line), reason: "same_variation_in_kept_cart" });
        continue;
      }
      nextOrder += 1;
      repair.moved.push({
        cartItemId: line.cartItemId,
        fromCartId: line.cartId,
        variationId: line.variationId,
        count: line.count,
        order: nextOrder,
      });
      keptByVariation.set(line.variationId, { cartItemId: line.cartItemId, count: line.count, sum: line.sum });
    }

    repair.moved.sort((a, b) => a.cartItemId - b.cartItemId);
    repair.raised.sort((a, b) => a.cartItemId - b.cartItemId);
    repair.left.sort((a, b) => a.cartItemId - b.cartItemId);
    users.push(repair);
  }

  return { users, unattributedOrphans: unattributed };
}

const pickLeft = (line: RepairLine) => ({
  cartItemId: line.cartItemId,
  cartId: line.cartId,
  variationId: line.variationId,
  count: line.count,
});

/* ------------------------------------------------------------------------------------ */
/* Database side                                                                         */
/* ------------------------------------------------------------------------------------ */

/** A pg `PoolClient` (or anything with the same `query`). One connection, one transaction. */
export type RepairClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
};

export type RepairOptions = {
  apply: boolean;
  includeOrphans: boolean;
  lockTimeoutMs?: number;
};

export type RepairSummary = {
  usersWithSeveralCarts: number;
  usersRepaired: number;
  cartsUnlinked: number;
  linesMoved: number;
  linesRaised: number;
  linesLeftSameVariation: number;
  linesLeftBoughtSince: number;
  linesLeftWithoutVariation: number;
  orphansConsidered: number;
  orphansRecovered: number;
  orphansLinked: number;
  orphansUnattributed: number;
  indexInstalled: boolean;
};

export type RepairReport = {
  applied: boolean;
  includeOrphans: boolean;
  summary: RepairSummary;
  users: UserRepair[];
  unattributedOrphans: UnattributedOrphan[];
};

class DryRunRollback extends Error {
  constructor(readonly report: RepairReport) {
    super("dry run");
  }
}

const toDate = (value: unknown): Date | null =>
  value instanceof Date ? value : value == null ? null : new Date(String(value));

const toNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const mergeVariationIds = (result: any): number[] => {
  const parsed = typeof result === "string" ? safeJson(result) : result;
  const entries = [
    ...(Array.isArray(parsed?.accepted) ? parsed.accepted : []),
    ...(Array.isArray(parsed?.adjusted) ? parsed.adjusted : []),
  ];
  return [
    ...new Set(
      entries
        .map((entry: any) => Number(entry?.productVariationId))
        .filter((id: number) => Number.isInteger(id) && id > 0),
    ),
  ];
};

const safeJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

async function readInput(client: RepairClient, includeOrphans: boolean): Promise<RepairInput> {
  const severalCartUsers = (
    await client.query(
      `SELECT user_id FROM carts_user_links
        WHERE user_id IS NOT NULL
        GROUP BY user_id
       HAVING COUNT(*) > 1`,
    )
  ).rows.map((row) => Number(row.user_id));

  let orphans: RepairCart[] = [];
  let mergeRows: any[] = [];
  if (includeOrphans) {
    orphans = (
      await client.query(
        `SELECT c.id, c.created_at, c.updated_at, c.status
           FROM carts c
          WHERE NOT EXISTS (SELECT 1 FROM carts_user_links l WHERE l.cart_id = c.id)
            AND EXISTS (SELECT 1 FROM cart_items_cart_links il WHERE il.cart_id = c.id)
          ORDER BY c.id`,
      )
    ).rows.map((row) => ({
      cartId: Number(row.id),
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
      status: row.status ?? null,
    }));
    if (orphans.length > 0) {
      mergeRows = (
        await client.query(
          `SELECT o.id AS orphan_cart_id, m.id AS merge_row_id, m.result,
                  COALESCE(
                    (SELECT array_agg(mu.user_id ORDER BY mu.user_id)
                       FROM guest_cart_merges_user_links mu
                      WHERE mu.guest_cart_merge_id = m.id AND mu.user_id IS NOT NULL),
                    '{}'
                  ) AS user_ids
             FROM carts o
             JOIN guest_cart_merges m
               ON m.created_at BETWEEN o.created_at - interval '1 second'
                                   AND o.created_at + interval '10 seconds'
            WHERE o.id = ANY($1::int[])`,
          [orphans.map((orphan) => orphan.cartId)],
        )
      ).rows;
    }
  }

  const mergeCandidates: RepairMergeCandidate[] = mergeRows.map((row) => ({
    orphanCartId: Number(row.orphan_cart_id),
    mergeRowId: Number(row.merge_row_id),
    userIds: (row.user_ids || []).map(Number),
    variationIds: mergeVariationIds(row.result),
  }));

  const involvedUsers = [
    ...new Set([...severalCartUsers, ...mergeCandidates.flatMap((row) => row.userIds)]),
  ];

  const links: RepairLink[] =
    involvedUsers.length === 0
      ? []
      : (
          await client.query(
            `SELECT l.user_id, l.cart_id, c.created_at, c.updated_at, c.status
               FROM carts_user_links l
               JOIN carts c ON c.id = l.cart_id
              WHERE l.user_id = ANY($1::int[])
              ORDER BY l.user_id, l.cart_id`,
            [involvedUsers],
          )
        ).rows.map((row) => ({
          userId: Number(row.user_id),
          cartId: Number(row.cart_id),
          createdAt: toDate(row.created_at),
          updatedAt: toDate(row.updated_at),
          status: row.status ?? null,
        }));

  const cartIds = [...new Set([...links.map((link) => link.cartId), ...orphans.map((orphan) => orphan.cartId)])];
  const lines: RepairLine[] =
    cartIds.length === 0
      ? []
      : (
          await client.query(
            `SELECT il.cart_id, il.cart_item_order, ci.id AS cart_item_id, ci.count, ci.sum,
                    ci.created_at, ci.updated_at, pv.product_variation_id
               FROM cart_items_cart_links il
               JOIN cart_items ci ON ci.id = il.cart_item_id
               LEFT JOIN cart_items_product_variation_links pv ON pv.cart_item_id = ci.id
              WHERE il.cart_id = ANY($1::int[])
              ORDER BY il.cart_id, ci.id`,
            [cartIds],
          )
        ).rows.map((row) => ({
          cartItemId: Number(row.cart_item_id),
          cartId: Number(row.cart_id),
          variationId: toNumberOrNull(row.product_variation_id),
          count: Number(row.count || 0),
          sum: Number(row.sum || 0),
          createdAt: toDate(row.created_at),
          updatedAt: toDate(row.updated_at),
          order: toNumberOrNull(row.cart_item_order),
        }));

  const purchases: RepairPurchase[] =
    involvedUsers.length === 0
      ? []
      : (
          await client.query(
            `SELECT DISTINCT ou.user_id, oiv.product_variation_id, o.created_at
               FROM orders o
               JOIN orders_user_links ou ON ou.order_id = o.id
               JOIN order_items_order_links oil ON oil.order_id = o.id
               JOIN order_items_product_variation_links oiv ON oiv.order_item_id = oil.order_item_id
              WHERE ou.user_id = ANY($1::int[])
                AND o.status IS DISTINCT FROM 'Cancelled'`,
            [involvedUsers],
          )
        ).rows.map((row) => ({
          userId: Number(row.user_id),
          variationId: Number(row.product_variation_id),
          orderedAt: toDate(row.created_at) as Date,
        }));

  return { links, orphans, mergeCandidates, lines, purchases };
}

const summarize = (
  plan: RepairPlan,
  input: RepairInput,
  options: RepairOptions,
  indexInstalled: boolean,
  applied: boolean,
): RepairReport => {
  const leftBy = (reason: KeptReason) =>
    plan.users.reduce((total, user) => total + user.left.filter((line) => line.reason === reason).length, 0);
  const linkCounts = new Map<number, number>();
  for (const link of input.links) linkCounts.set(link.userId, (linkCounts.get(link.userId) || 0) + 1);
  return {
    applied,
    includeOrphans: options.includeOrphans,
    summary: {
      usersWithSeveralCarts: [...linkCounts.values()].filter((count) => count > 1).length,
      usersRepaired: plan.users.length,
      cartsUnlinked: plan.users.reduce((total, user) => total + user.unlinkedCartIds.length, 0),
      linesMoved: plan.users.reduce((total, user) => total + user.moved.length, 0),
      linesRaised: plan.users.reduce((total, user) => total + user.raised.length, 0),
      linesLeftSameVariation: leftBy("same_variation_in_kept_cart"),
      linesLeftBoughtSince: leftBy("bought_since"),
      linesLeftWithoutVariation: leftBy("no_variation"),
      orphansConsidered: input.orphans.length,
      orphansRecovered: plan.users.reduce((total, user) => total + user.recoveredOrphanCartIds.length, 0),
      orphansLinked: plan.users.filter((user) => user.linkedOrphanCartId !== null).length,
      orphansUnattributed: plan.unattributedOrphans.length,
      indexInstalled,
    },
    users: plan.users,
    unattributedOrphans: plan.unattributedOrphans,
  };
};

/** `($1,$2),($3,$4)…` for a VALUES list, plus the flattened parameters. */
const valuesList = (rows: unknown[][], casts: string[], offset = 0) => {
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const cells = row.map((value, index) => {
      params.push(value);
      return `$${offset + params.length}::${casts[index]}`;
    });
    return `(${cells.join(", ")})`;
  });
  return { sql: tuples.join(", "), params };
};

const CHUNK = 500;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += CHUNK) out.push(items.slice(index, index + CHUNK));
  return out;
};

async function applyPlan(client: RepairClient, plan: RepairPlan): Promise<void> {
  const now = new Date();

  const moves = plan.users.flatMap((user) =>
    user.moved.map((move) => [move.cartItemId, move.fromCartId, user.keptCartId, move.order]),
  );
  for (const batch of chunks(moves)) {
    const { sql, params } = valuesList(batch, ["int", "int", "int", "float8"]);
    const result = await client.query(
      `UPDATE cart_items_cart_links AS il
          SET cart_id = v.to_cart_id, cart_item_order = v.item_order
         FROM (VALUES ${sql}) AS v(cart_item_id, from_cart_id, to_cart_id, item_order)
        WHERE il.cart_item_id = v.cart_item_id AND il.cart_id = v.from_cart_id`,
      params,
    );
    if (result.rowCount !== batch.length) {
      throw new Error(`Line move touched ${result.rowCount} rows, expected ${batch.length}`);
    }
  }

  const raises = plan.users.flatMap((user) =>
    user.raised.map((raise) => [raise.cartItemId, raise.toCount, raise.toSum]),
  );
  for (const batch of chunks(raises)) {
    const { sql, params } = valuesList(batch, ["int", "int", "int8"]);
    const result = await client.query(
      `UPDATE cart_items AS ci
          SET count = v.count, sum = v.sum, updated_at = $${params.length + 1}
         FROM (VALUES ${sql}) AS v(id, count, sum)
        WHERE ci.id = v.id`,
      [...params, now],
    );
    if (result.rowCount !== batch.length) {
      throw new Error(`Quantity raise touched ${result.rowCount} rows, expected ${batch.length}`);
    }
  }

  const unlinks = plan.users.flatMap((user) =>
    user.unlinkedCartIds.map((cartId) => [user.userId, cartId]),
  );
  for (const batch of chunks(unlinks)) {
    const { sql, params } = valuesList(batch, ["int", "int"]);
    const result = await client.query(
      `DELETE FROM carts_user_links AS l
        USING (VALUES ${sql}) AS v(user_id, cart_id)
        WHERE l.user_id = v.user_id AND l.cart_id = v.cart_id`,
      params,
    );
    if (result.rowCount !== batch.length) {
      throw new Error(`Unlink touched ${result.rowCount} rows, expected ${batch.length}`);
    }
  }

  const orphanLinks = plan.users
    .filter((user) => user.linkedOrphanCartId !== null)
    .map((user) => [user.linkedOrphanCartId, user.userId]);
  for (const batch of chunks(orphanLinks)) {
    const { sql, params } = valuesList(batch, ["int", "int"]);
    await client.query(`INSERT INTO carts_user_links (cart_id, user_id) VALUES ${sql}`, params);
  }

  const touched = plan.users
    .filter((user) => user.moved.length > 0 || user.raised.length > 0 || user.linkedOrphanCartId !== null)
    .map((user) => user.keptCartId);
  if (touched.length > 0) {
    await client.query(
      `UPDATE carts SET status = 'Pending', updated_at = $2
        WHERE id = ANY($1::int[])
          AND EXISTS (SELECT 1 FROM cart_items_cart_links il WHERE il.cart_id = carts.id)`,
      [touched, now],
    );
  }
}

/**
 * Re-reads the result inside the transaction and throws (rolling everything back) if
 * any user still owns several carts, a kept cart gained a duplicated variation, or a
 * line that should have survived is missing from the kept cart at its quantity.
 */
async function verify(client: RepairClient, plan: RepairPlan, input: RepairInput): Promise<void> {
  const several = Number((await client.query(COUNT_USERS_WITH_SEVERAL_CARTS_SQL)).rows[0]?.count || 0);
  if (several > 0) throw new Error(`${several} users still own more than one cart`);

  const keptIds = plan.users.map((user) => user.keptCartId);
  if (keptIds.length === 0) return;

  const after = (
    await client.query(
      `SELECT il.cart_id, ci.id AS cart_item_id, ci.count, pv.product_variation_id
         FROM cart_items_cart_links il
         JOIN cart_items ci ON ci.id = il.cart_item_id
         LEFT JOIN cart_items_product_variation_links pv ON pv.cart_item_id = ci.id
        WHERE il.cart_id = ANY($1::int[])`,
      [keptIds],
    )
  ).rows.map((row) => ({
    cartId: Number(row.cart_id),
    variationId: toNumberOrNull(row.product_variation_id),
    count: Number(row.count || 0),
  }));

  const duplicateVariations = (lines: Array<{ cartId: number; variationId: number | null }>) => {
    const seen = new Set<string>();
    let duplicates = 0;
    for (const line of lines) {
      if (line.variationId === null) continue;
      const key = `${line.cartId}:${line.variationId}`;
      if (seen.has(key)) duplicates += 1;
      seen.add(key);
    }
    return duplicates;
  };
  const keptSet = new Set(keptIds);
  const before = duplicateVariations(input.lines.filter((line) => keptSet.has(line.cartId)));
  if (duplicateVariations(after) > before) {
    throw new Error("A kept cart gained a duplicated variation");
  }

  const ownerLinks = (
    await client.query(
      `SELECT user_id, cart_id FROM carts_user_links WHERE cart_id = ANY($1::int[])`,
      [keptIds],
    )
  ).rows;
  const ownerOf = new Map(ownerLinks.map((row) => [Number(row.cart_id), Number(row.user_id)]));

  for (const user of plan.users) {
    if (ownerOf.get(user.keptCartId) !== user.userId) {
      throw new Error(`Kept cart ${user.keptCartId} is not linked to user ${user.userId}`);
    }
    const keptLines = after.filter((line) => line.cartId === user.keptCartId);
    const skipped = new Set(
      user.left.filter((line) => line.reason !== "same_variation_in_kept_cart").map((line) => line.cartItemId),
    );
    const cartIds = new Set([
      user.keptCartId,
      ...user.unlinkedCartIds,
      ...user.recoveredOrphanCartIds,
    ]);
    for (const line of input.lines) {
      if (!cartIds.has(line.cartId) || skipped.has(line.cartItemId) || line.variationId === null) continue;
      const best = Math.max(
        0,
        ...keptLines.filter((kept) => kept.variationId === line.variationId).map((kept) => kept.count),
      );
      if (best < line.count) {
        throw new Error(
          `User ${user.userId} would lose variation ${line.variationId} (had ${line.count}, kept ${best})`,
        );
      }
    }
  }
}

/**
 * Runs the whole repair on one connection in one transaction. Dry run (the default)
 * performs every step, including the index build and verification, then rolls back.
 */
export async function repairUserCarts(
  client: RepairClient,
  options: RepairOptions,
): Promise<RepairReport> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${Math.max(1000, options.lockTimeoutMs ?? 5000)}ms'`);
    await client.query("SET LOCAL statement_timeout = '120s'");
    // Blocks cart and cart-line writes (reads continue) for the second this takes, so no
    // writer — including an older release still draining — can add a duplicate between
    // the consolidation and the index build.
    await client.query(
      "LOCK TABLE carts_user_links, cart_items_cart_links, cart_items IN SHARE ROW EXCLUSIVE MODE",
    );

    const input = await readInput(client, options.includeOrphans);
    const plan = planUserCartRepair(input);
    await applyPlan(client, plan);
    await client.query(CART_ONE_PER_USER_INDEX_SQL);
    const state = (await client.query(CART_INDEX_STATE_SQL)).rows[0];
    if (state?.valid !== true) {
      throw new Error(`${CART_ONE_PER_USER_INDEX} is missing or invalid after the build`);
    }
    await verify(client, plan, input);

    const report = summarize(plan, input, options, true, options.apply);
    if (!options.apply) throw new DryRunRollback(report);
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof DryRunRollback) return error.report;
    throw error;
  }
}
