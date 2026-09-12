const migration = require("../../../../../database/migrations/2026.09.12T10.00.00.add-order-recipient-sync-state.js");

describe("order recipient sync migration", () => {
  it("adds durable revision, status, retry and timestamp fields", () => {
    expect(migration.__private.TABLE).toBe("orders");
    expect(migration.__private.COLUMNS.map(([name]: [string]) => name)).toEqual([
      "anipo_recipient_revision",
      "anipo_recipient_synced_revision",
      "anipo_recipient_sync_state",
      "anipo_recipient_sync_attempts",
      "anipo_recipient_sync_last_attempt_at",
      "anipo_recipient_sync_last_error",
      "anipo_recipient_synced_at",
    ]);
    expect(migration.__private.INDEX).toBe("idx_orders_anipo_recipient_sync_due");
  });
});
