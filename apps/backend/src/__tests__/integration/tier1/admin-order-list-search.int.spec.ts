/**
 * Admin orders list search by shipping recipient, on real Postgres.
 *
 * Nested `$containsi` on `delivery_address.FullName` has to survive the same
 * class of failures as recent varchar work: quoted camelCase columns that do
 * not exist, `$eq` binds longer than `varchar(n)` (Postgres 22001 on SELECT),
 * and ILIKE against the actual `full_name` column.
 */
import controller from "../../../api/admin-order-list/controllers/admin-order-list";
import { MAX_ADMIN_SEARCH_LENGTH } from "../../../utils/admin-list-query";
import { makeFactories, TEST_PREFIX, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;
let f: Factories;

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

beforeEach(() => {
  f = makeFactories(strapi);
});

afterEach(async () => {
  await f.cleanup();
});

function listCtx(body: Record<string, unknown>) {
  return {
    request: { body },
    state: { auth: {}, user: { id: 1 } },
    body: null as unknown,
    badRequest: jest.fn((message: string) => {
      throw new Error(message);
    }),
    set: jest.fn(),
  };
}

async function seedOrderWithDistinctNames() {
  const user = await f.createUser();
  const accountFirst = `${TEST_PREFIX}حساب`;
  const accountLast = `${TEST_PREFIX}کاربری`;
  await f.createUserInfo({
    userId: user.id,
    firstName: accountFirst,
    lastName: accountLast,
  });
  const recipientName = `${TEST_PREFIX}گیرنده-${user.id}`;
  const address = await f.createAddress({ userId: user.id, fullName: recipientName });
  const contract = await f.createContract({ userId: user.id, amount: 150000, status: "Confirmed" });
  const order = await f.createOrder({
    userId: user.id,
    contractId: contract.id,
    deliveryAddressId: address.id,
    status: "Started",
  });
  return { order, recipientName, accountFirst, accountLast };
}

describe("admin orders list recipient search (real Postgres)", () => {
  it("stores FullName on unquoted snake_case varchar full_name, not quoted camelCase", async () => {
    const knex = strapi.db.connection;
    const columns = await knex("information_schema.columns")
      .select("column_name", "data_type", "udt_name", "character_maximum_length")
      .where({ table_name: "local_user_addresses" })
      .whereIn("column_name", ["full_name", "FullName"]);

    const names = columns.map((column: { column_name: string }) => column.column_name);
    expect(names).toContain("full_name");
    expect(names).not.toContain("FullName");

    const fullName = columns.find(
      (column: { column_name: string }) => column.column_name === "full_name",
    );
    expect(fullName.data_type === "text" || fullName.udt_name === "text" || Number(fullName.character_maximum_length) >= 255).toBe(
      true,
    );
  });

  it("finds an order by shipping recipient and not by a different account name", async () => {
    const { order, recipientName, accountFirst } = await seedOrderWithDistinctNames();
    const other = await seedOrderWithDistinctNames();

    const ctx = listCtx({
      page: 1,
      pageSize: 25,
      tab: "all",
      sort: "newest",
      search: recipientName,
    });
    await controller.query(ctx);

    const ids = ((ctx.body as { data?: Array<{ id: number }> }).data ?? []).map((row) => Number(row.id));
    expect(ids).toContain(order.id);
    expect(ids).not.toContain(other.order.id);

    const hit = (ctx.body as { data: Array<{ id: number; attributes: { recipientName?: string | null } }> }).data.find(
      (row) => Number(row.id) === Number(order.id),
    );
    expect(hit?.attributes.recipientName).toBe(recipientName);
    expect(hit?.attributes.recipientName).not.toContain(accountFirst);
  });

  it("still finds the order by the account profile name", async () => {
    const { order, accountLast } = await seedOrderWithDistinctNames();
    const ctx = listCtx({
      page: 1,
      pageSize: 25,
      tab: "all",
      sort: "newest",
      search: accountLast,
    });
    await controller.query(ctx);
    const ids = ((ctx.body as { data?: Array<{ id: number }> }).data ?? []).map((row) => Number(row.id));
    expect(ids).toContain(order.id);
  });

  it("ILIKE-matches full_name in SQL and does not 22001 on a max-length search", async () => {
    const { order, recipientName } = await seedOrderWithDistinctNames();
    const knex = strapi.db.connection;

    const sqlHit = await knex("local_user_addresses")
      .select("id")
      .whereRaw("full_name ILIKE ?", [`%${recipientName}%`]);
    expect(sqlHit.length).toBeGreaterThan(0);

    const maxSearch = `${recipientName} ${"x".repeat(MAX_ADMIN_SEARCH_LENGTH)}`.slice(
      0,
      MAX_ADMIN_SEARCH_LENGTH,
    );
    const ctx = listCtx({
      page: 1,
      pageSize: 25,
      tab: "all",
      sort: "newest",
      search: maxSearch,
    });
    await expect(controller.query(ctx)).resolves.toBeUndefined();
    expect(ctx.badRequest).not.toHaveBeenCalled();

    // A value longer than varchar(64) would 22001 on `$eq`. ILIKE must not.
    await expect(
      knex.raw("SELECT 1 FROM local_user_addresses WHERE full_name ILIKE ? LIMIT 1", [
        `%${"گ".repeat(80)}%`,
      ]),
    ).resolves.toBeTruthy();

    const ids = ((ctx.body as { data?: Array<{ id: number }> }).data ?? []).map((row) => Number(row.id));
    expect(ids).not.toContain(order.id);
  });
});
