jest.mock("../../../../queue/product-publication-queue", () => ({
  enqueueScheduledProductPublication: jest.fn(),
  removeScheduledProductPublication: jest.fn(),
}));
jest.mock("../../../../audit/writer", () => ({
  resolveCurrentAuditContext: jest.fn(() => null),
  writeAuditEvent: jest.fn(),
}));

import {
  LIFECYCLE_TRANSITIONS,
  LifecycleTransitionError,
  resolveLifecycleTransition,
  type ProductLifecycleCommand,
} from "../product-lifecycle-rules";
import {
  BULK_ACTION_CAPABILITY,
  MAX_BULK_PRODUCTS,
  UNDO_WINDOW_MS,
  decideRestoreTarget,
  parseBulkProductIds,
  previousStatusOf,
  purgedSku,
} from "../product-lifecycle";
import {
  isProductPubliclyVisible,
  productLifecycleState,
  productUnavailableReason,
} from "../../../../utils/productVisibility";

const now = new Date("2026-09-27T10:00:00.000Z");

describe("product visibility rule", () => {
  it.each([
    [{ Status: "Active", removedAt: null }, true],
    [{ Status: "InActive", removedAt: null }, false],
    [{ Status: "Scheduled", removedAt: null }, false],
    [{ Status: "Active", removedAt: "2026-09-01T00:00:00.000Z" }, false],
    [{ status: "Active", removed_at: null }, true],
    [{ attributes: { Status: "Active", removedAt: null } }, true],
    [null, false],
  ])("%j is public: %s", (product, expected) => {
    expect(isProductPubliclyVisible(product as any)).toBe(expected);
  });

  it("derives one lifecycle state with deletion winning over a stale status", () => {
    expect(productLifecycleState({ Status: "Active" })).toBe("published");
    expect(productLifecycleState({ Status: "Scheduled" })).toBe("scheduled");
    expect(productLifecycleState({ Status: "InActive" })).toBe("draft");
    expect(productLifecycleState({ status: null } as any)).toBe("draft");
    expect(productLifecycleState({ Status: "Active", removedAt: "x" })).toBe("trashed");
    expect(productLifecycleState({ removed_at: "x", purged_at: "y" } as any)).toBe("purged");
  });

  it("names why a cart line stopped being sellable", () => {
    expect(productUnavailableReason(null)).toBe("PRODUCT_NOT_FOUND");
    expect(productUnavailableReason({ Status: "Active", removedAt: "x" })).toBe("PRODUCT_DELETED");
    expect(productUnavailableReason({ Status: "Scheduled" })).toBe("PRODUCT_INACTIVE");
    expect(productUnavailableReason({ Status: "InActive" })).toBe("PRODUCT_INACTIVE");
    expect(productUnavailableReason({ Status: "Active", removedAt: null })).toBeNull();
  });
});

describe("lifecycle transition matrix", () => {
  const allowed: Array<[string, ProductLifecycleCommand, string]> = [
    ["draft", "publish", "published"],
    ["draft", "schedule", "scheduled"],
    ["draft", "trash", "trashed"],
    ["scheduled", "publish", "published"],
    ["scheduled", "schedule", "scheduled"],
    ["scheduled", "unpublish", "draft"],
    ["scheduled", "trash", "trashed"],
    ["published", "unpublish", "draft"],
    ["published", "trash", "trashed"],
    ["trashed", "restore", "draft"],
    ["trashed", "purge", "purged"],
  ];
  it.each(allowed)("%s → %s lands on %s", (from, command, to) => {
    expect(resolveLifecycleTransition(from as any, command)).toEqual({ from, to, noop: false });
  });

  it.each([
    ["draft", "unpublish"],
    ["published", "publish"],
    ["trashed", "trash"],
    ["purged", "purge"],
  ])("repeating %s + %s is an idempotent no-op", (from, command) => {
    expect(resolveLifecycleTransition(from as any, command as ProductLifecycleCommand).noop).toBe(true);
  });

  it.each([
    ["trashed", "publish", "PRODUCT_REMOVED"],
    ["trashed", "schedule", "PRODUCT_REMOVED"],
    ["trashed", "unpublish", "PRODUCT_REMOVED"],
    ["published", "schedule", "SCHEDULED_UPDATE_UNSUPPORTED"],
    ["draft", "restore", "PRODUCT_NOT_IN_TRASH"],
    ["published", "purge", "PRODUCT_NOT_IN_TRASH"],
    ["scheduled", "purge", "PRODUCT_NOT_IN_TRASH"],
    ["purged", "restore", "PRODUCT_PURGED"],
    ["purged", "publish", "PRODUCT_PURGED"],
  ])("refuses %s + %s with %s", (from, command, code) => {
    expect(() => resolveLifecycleTransition(from as any, command as ProductLifecycleCommand)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("never lets Trash lead straight to published", () => {
    for (const command of Object.keys(LIFECYCLE_TRANSITIONS.trashed) as ProductLifecycleCommand[]) {
      try {
        expect(resolveLifecycleTransition("trashed", command).to).not.toBe("published");
      } catch (error) {
        expect(error).toBeInstanceOf(LifecycleTransitionError);
      }
    }
  });
});

describe("restore target", () => {
  const trashedRow = (overrides: Record<string, unknown> = {}) => ({
    removed_at: new Date(now.getTime() - 30_000),
    removed_by_id: 7,
    pre_removal_status: "Active" as const,
    status: "InActive" as const,
    pre_removal_scheduled_publish_at: null,
    ...overrides,
  });

  it("always restores to draft without an undo token, even a published product", () => {
    expect(decideRestoreTarget(trashedRow(), { now, actorId: 7, canPublish: true })).toEqual({
      target: "draft",
      undo: false,
      warnings: [],
    });
  });

  it("lets the same admin undo a trash back to published right away", () => {
    const row = trashedRow();
    expect(
      decideRestoreTarget(row, {
        now,
        actorId: 7,
        canPublish: true,
        undoToken: (row.removed_at as Date).toISOString(),
      }),
    ).toEqual({ target: "published", undo: true, warnings: [] });
  });

  it.each([
    ["another admin", { actorId: 8 }],
    ["a stale token", { undoToken: "2026-09-27T09:00:00.000Z" }],
    ["too late", { now: new Date(now.getTime() + UNDO_WINDOW_MS) }],
  ])("degrades undo to draft for %s", (_label, override) => {
    const row = trashedRow();
    expect(
      decideRestoreTarget(row, {
        now,
        actorId: 7,
        canPublish: true,
        undoToken: (row.removed_at as Date).toISOString(),
        ...override,
      }),
    ).toEqual({ target: "draft", undo: false, warnings: ["UNDO_EXPIRED"] });
  });

  it("does not republish through undo without the publish capability", () => {
    const row = trashedRow();
    expect(
      decideRestoreTarget(row, {
        now,
        actorId: 7,
        canPublish: false,
        undoToken: (row.removed_at as Date).toISOString(),
      }),
    ).toEqual({ target: "draft", undo: true, warnings: ["UNDO_PUBLISH_NOT_ALLOWED"] });
  });

  it("keeps a schedule that is still ahead and never runs an expired one", () => {
    const future = trashedRow({
      pre_removal_status: "Scheduled",
      pre_removal_scheduled_publish_at: "2026-09-28T08:00:00.000Z",
    });
    const token = (future.removed_at as Date).toISOString();
    expect(decideRestoreTarget(future, { now, actorId: 7, canSchedule: true, undoToken: token })).toEqual({
      target: "scheduled",
      undo: true,
      publishAt: "2026-09-28T08:00:00.000Z",
      warnings: [],
    });

    const expired = trashedRow({
      pre_removal_status: "Scheduled",
      pre_removal_scheduled_publish_at: "2026-09-27T10:00:30.000Z",
    });
    expect(
      decideRestoreTarget(expired, { now, actorId: 7, canSchedule: true, undoToken: token }),
    ).toEqual({ target: "draft", undo: true, warnings: ["SCHEDULE_EXPIRED"] });
  });

  it("reads a legacy trashed row's previous status from its undemoted status", () => {
    expect(previousStatusOf({ pre_removal_status: null, status: "Active" })).toBe("Active");
    expect(previousStatusOf({ pre_removal_status: "Scheduled", status: "InActive" })).toBe("Scheduled");
  });
});

describe("permanent deletion identifiers", () => {
  it("frees a SKU by suffixing it with the product id", () => {
    expect(purgedSku("ABC-1", 42)).toBe("ABC-1~purged-42");
  });

  it("keeps a suffixed SKU within the varchar(255) column", () => {
    const sku = purgedSku("S".repeat(255), 123456);
    expect(sku).toHaveLength(255);
    expect(sku.endsWith("~purged-123456")).toBe(true);
  });
});

describe("bulk requests", () => {
  it("dedupes ids and bounds the batch", () => {
    expect(parseBulkProductIds([3, "3", 4])).toEqual([3, 4]);
    expect(() => parseBulkProductIds([])).toThrow(expect.objectContaining({ code: "BULK_IDS_REQUIRED" }));
    expect(() => parseBulkProductIds([1, "x"])).toThrow(expect.objectContaining({ code: "PRODUCT_ID_INVALID" }));
    expect(() =>
      parseBulkProductIds(Array.from({ length: MAX_BULK_PRODUCTS + 1 }, (_, index) => index + 1)),
    ).toThrow(expect.objectContaining({ code: "BULK_LIMIT_EXCEEDED" }));
  });

  it("maps every bulk action to the capability its single-product route uses", () => {
    expect(BULK_ACTION_CAPABILITY).toEqual({
      publish: "product.publish",
      unpublish: "product.publish",
      schedule: "product.schedule",
      trash: "product.softDelete",
      restore: "product.restore",
      purge: "product.delete",
    });
  });
});
