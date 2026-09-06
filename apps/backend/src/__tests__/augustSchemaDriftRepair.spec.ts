const MIGRATION_DIR = "../../database/migrations";

const WRAPPED = [
  "2026.08.07T18.00.00.add-customer-identity-lifecycle.js",
  "2026.08.08T12.00.00.add-product-scheduled-publication.js",
  "2026.08.09T09.00.00.add-umami-analytics-outbox.js",
  "2026.08.11T09.00.00.add-checkout-line-identity-and-coupon-claim.js",
  "2026.08.11T12.00.00.add-commerce-integrity-state.js",
] as const;

for (const name of WRAPPED) {
  jest.mock(`${MIGRATION_DIR}/${name}`, () => ({ up: jest.fn().mockResolvedValue(undefined) }), {
    virtual: false,
  });
}

const repair = require(`${MIGRATION_DIR}/2026.09.06T10.00.00.repair-august-schema-drift.js`);
const wrapped = WRAPPED.map((name) => require(`${MIGRATION_DIR}/${name}`));

describe("August schema drift repair migration", () => {
  beforeEach(() => {
    wrapped.forEach((mod: any) => mod.up.mockClear());
  });

  it("replays every wrapped migration's up() against the same knex", async () => {
    const knex = {} as any;

    await repair.up(knex);

    for (const mod of wrapped as any[]) {
      expect(mod.up).toHaveBeenCalledTimes(1);
      expect(mod.up).toHaveBeenCalledWith(knex);
    }
  });

  it("is safe to rerun", async () => {
    const knex = {} as any;

    await repair.up(knex);
    await repair.up(knex);

    for (const mod of wrapped as any[]) {
      expect(mod.up).toHaveBeenCalledTimes(2);
    }
  });

  it("does not wrap the admin audit rebuild, whose backfill the append-only trigger rejects", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, MIGRATION_DIR, "2026.09.06T10.00.00.repair-august-schema-drift.js"),
      "utf8",
    );

    expect(source).not.toContain("rebuild-admin-audit-events.js\")");
  });

  // Forward-only: rolling back would drop commerce state the wrapped migrations own.
  it("has a no-op down()", async () => {
    await expect(repair.down()).resolves.toBeUndefined();
  });
});
