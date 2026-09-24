import {
  planUserCartRepair,
  type RepairInput,
  type RepairLine,
  type RepairLink,
} from "../cart-repair";

const at = (iso: string) => new Date(iso);
const EARLY = "2026-09-20T10:00:00Z";
const LATE = "2026-09-20T11:00:00Z";

const link = (userId: number, cartId: number, updatedAt = EARLY): RepairLink => ({
  userId,
  cartId,
  createdAt: at(EARLY),
  updatedAt: at(updatedAt),
  status: "Pending",
});

const line = (
  cartItemId: number,
  cartId: number,
  variationId: number | null,
  count: number,
  opts: { updatedAt?: string; createdAt?: string; order?: number; unit?: number } = {},
): RepairLine => ({
  cartItemId,
  cartId,
  variationId,
  count,
  sum: count * (opts.unit ?? 100),
  createdAt: at(opts.createdAt ?? EARLY),
  updatedAt: at(opts.updatedAt ?? EARLY),
  order: opts.order ?? 1,
});

const input = (partial: Partial<RepairInput>): RepairInput => ({
  links: [],
  orphans: [],
  mergeCandidates: [],
  lines: [],
  purchases: [],
  ...partial,
});

describe("planUserCartRepair: several linked carts", () => {
  it("keeps the cart with lines over a newer empty one and moves nothing", () => {
    const plan = planUserCartRepair(
      input({ links: [link(1, 10, LATE), link(1, 11)], lines: [line(100, 11, 7, 2)] }),
    );

    expect(plan.users).toEqual([
      expect.objectContaining({ userId: 1, keptCartId: 11, unlinkedCartIds: [10], moved: [], raised: [], left: [] }),
    ]);
  });

  it("keeps the most recently active cart and moves the other cart's distinct lines after its own", () => {
    const plan = planUserCartRepair(
      input({
        links: [link(1, 10), link(1, 11)],
        lines: [
          line(100, 10, 7, 1, { order: 1 }),
          line(101, 10, 8, 1, { order: 2 }),
          line(110, 11, 7, 1, { updatedAt: LATE, order: 4 }),
        ],
      }),
    );

    const [user] = plan.users;
    expect(user.keptCartId).toBe(11);
    expect(user.unlinkedCartIds).toEqual([10]);
    expect(user.moved).toEqual([{ cartItemId: 101, fromCartId: 10, variationId: 8, count: 1, order: 5 }]);
    expect(user.raised).toEqual([]);
    expect(user.left).toEqual([
      { cartItemId: 100, cartId: 10, variationId: 7, count: 1, reason: "same_variation_in_kept_cart" },
    ]);
  });

  it("takes the larger quantity for a variation in both carts, never the sum", () => {
    const plan = planUserCartRepair(
      input({
        links: [link(1, 10), link(1, 11)],
        lines: [line(100, 10, 7, 3, { unit: 90 }), line(110, 11, 7, 1, { updatedAt: LATE })],
      }),
    );

    const [user] = plan.users;
    expect(user.keptCartId).toBe(11);
    expect(user.raised).toEqual([
      { cartItemId: 110, variationId: 7, fromCount: 1, toCount: 3, fromSum: 100, toSum: 270, sourceCartItemId: 100 },
    ]);
    expect(user.moved).toEqual([]);
  });

  it("moves one line per variation across three carts, the one with the larger quantity", () => {
    const plan = planUserCartRepair(
      input({
        links: [link(1, 10), link(1, 11), link(1, 12, LATE)],
        lines: [line(100, 10, 7, 2), line(110, 11, 7, 3), line(120, 12, 9, 1, { updatedAt: LATE })],
      }),
    );

    const [user] = plan.users;
    expect(user.keptCartId).toBe(12);
    expect(user.unlinkedCartIds.sort()).toEqual([10, 11]);
    expect(user.moved.map((move) => move.cartItemId)).toEqual([110]);
    expect(user.left).toEqual([
      expect.objectContaining({ cartItemId: 100, reason: "same_variation_in_kept_cart" }),
    ]);
  });

  it("leaves a line without a variation behind", () => {
    const plan = planUserCartRepair(
      input({ links: [link(1, 10), link(1, 11, LATE)], lines: [line(100, 10, null, 1), line(110, 11, 7, 1)] }),
    );

    expect(plan.users[0].left).toEqual([expect.objectContaining({ cartItemId: 100, reason: "no_variation" })]);
    expect(plan.users[0].moved).toEqual([]);
  });

  it("leaves a line the customer has ordered since, but moves one ordered before it was added", () => {
    const plan = planUserCartRepair(
      input({
        links: [link(1, 10), link(1, 11, LATE)],
        lines: [
          line(100, 10, 7, 1, { createdAt: EARLY }),
          line(101, 10, 8, 1, { createdAt: LATE }),
          line(110, 11, 9, 1),
        ],
        purchases: [
          { userId: 1, variationId: 7, orderedAt: at("2026-09-21T09:00:00Z") },
          { userId: 1, variationId: 8, orderedAt: at("2026-09-19T09:00:00Z") },
        ],
      }),
    );

    const [user] = plan.users;
    expect(user.left).toEqual([expect.objectContaining({ cartItemId: 100, reason: "bought_since" })]);
    expect(user.moved.map((move) => move.cartItemId)).toEqual([101]);
  });

  it("breaks an activity tie by the lowest cart id and ignores users with one cart", () => {
    const plan = planUserCartRepair(
      input({
        links: [link(1, 11), link(1, 10), link(2, 20)],
        lines: [line(100, 10, 7, 1), line(110, 11, 8, 1), line(200, 20, 7, 1)],
      }),
    );

    expect(plan.users.map((user) => [user.userId, user.keptCartId])).toEqual([[1, 10]]);
  });
});

describe("planUserCartRepair: carts that lost their owner", () => {
  const orphan = (cartId: number) => ({
    cartId,
    createdAt: at(EARLY),
    updatedAt: at(EARLY),
    status: "Pending",
  });

  it("recovers an orphan whose single merge record matches its variations exactly", () => {
    const plan = planUserCartRepair(
      input({
        links: [link(5, 50, LATE)],
        orphans: [orphan(60)],
        mergeCandidates: [{ orphanCartId: 60, mergeRowId: 1, userIds: [5], variationIds: [7, 8] }],
        lines: [line(600, 60, 7, 2), line(601, 60, 8, 1), line(500, 50, 8, 1)],
      }),
    );

    expect(plan.unattributedOrphans).toEqual([]);
    expect(plan.users).toEqual([
      expect.objectContaining({
        userId: 5,
        keptCartId: 50,
        unlinkedCartIds: [],
        recoveredOrphanCartIds: [60],
        linkedOrphanCartId: null,
        moved: [expect.objectContaining({ cartItemId: 600, fromCartId: 60, variationId: 7, count: 2 })],
        left: [expect.objectContaining({ cartItemId: 601, reason: "same_variation_in_kept_cart" })],
      }),
    ]);
  });

  it("links the orphan itself when its owner has no cart", () => {
    const plan = planUserCartRepair(
      input({
        orphans: [orphan(60)],
        mergeCandidates: [{ orphanCartId: 60, mergeRowId: 1, userIds: [5], variationIds: [7] }],
        lines: [line(600, 60, 7, 1)],
      }),
    );

    expect(plan.users).toEqual([
      expect.objectContaining({ userId: 5, keptCartId: 60, linkedOrphanCartId: 60, moved: [], left: [] }),
    ]);
  });

  it("leaves ambiguous, mismatched and shared attributions for manual review", () => {
    const plan = planUserCartRepair(
      input({
        orphans: [orphan(60), orphan(61), orphan(62), orphan(63), orphan(64), orphan(65)],
        mergeCandidates: [
          // 60: two merges from different users with the same variations.
          { orphanCartId: 60, mergeRowId: 1, userIds: [5], variationIds: [7] },
          { orphanCartId: 60, mergeRowId: 2, userIds: [6], variationIds: [7] },
          // 61: the merge holds more variations than the cart (subset is not identical).
          { orphanCartId: 61, mergeRowId: 3, userIds: [5], variationIds: [7, 8] },
          // 62 and 63: one merge record would claim both carts.
          { orphanCartId: 62, mergeRowId: 4, userIds: [5], variationIds: [9] },
          { orphanCartId: 63, mergeRowId: 4, userIds: [5], variationIds: [9] },
          // 65: a line with no variation can never match exactly.
          { orphanCartId: 65, mergeRowId: 5, userIds: [5], variationIds: [7] },
        ],
        lines: [
          line(600, 60, 7, 1),
          line(610, 61, 7, 1),
          line(620, 62, 9, 1),
          line(630, 63, 9, 1),
          line(640, 64, 7, 1),
          line(650, 65, 7, 1),
          line(651, 65, null, 1),
        ],
      }),
    );

    expect(plan.users).toEqual([]);
    expect(plan.unattributedOrphans.map((entry) => [entry.cartId, entry.reason])).toEqual([
      [60, "several_matching_merges"],
      [61, "variation_set_mismatch"],
      [62, "merge_matches_several_orphans"],
      [63, "merge_matches_several_orphans"],
      [64, "no_merge_in_window"],
      [65, "line_without_variation"],
    ]);
  });
});
