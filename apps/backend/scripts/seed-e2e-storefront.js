#!/usr/bin/env node
/**
 * Seed deterministic storefront fixtures for Playwright E2E smoke tests.
 *
 * The script is intentionally local/CI-test only:
 * - every owned catalog row is tagged with external_source = "e2e-storefront"
 * - media is identified by a deterministic upload hash
 * - teardown removes only those tagged rows and link-table rows pointing at them
 * - production/staging-looking database names are refused unless --force is passed
 *
 * Usage:
 *   pnpm --filter @repo/backend seed:e2e
 *   pnpm --filter @repo/backend seed:e2e -- --teardown
 */

const path = require("path");
const fs = require("fs/promises");

try {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
} catch {
  // dotenv is optional when CI injects database variables directly.
}

const { Client } = require("pg");
const bcrypt = require("bcryptjs");

const TAG = "e2e-storefront";
const MEDIA_HASHES = ["e2e_storefront_cover", "e2e_storefront_detail"];
const ADMIN_CATEGORY_SLUG_PREFIX = "e2e-admin-crud-category";
const FIXTURE_UPLOAD_FILE = "Cyan_DM_id_WAHX_9y_Gx_0_ea75d58006.webp";

function envOrDefault(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

const FIXTURE = {
  category: {
    title: "E2E Storefront Category",
    slug: "e2e-storefront",
    externalId: "e2e-storefront:category",
  },
  product: {
    title: "E2E G001 Storefront Smoke Product",
    slug: "e2e-storefront-smoke-product",
    externalId: "e2e-storefront:product",
  },
  media: [
    {
      name: "e2e-storefront-cover.webp",
      fileName: "Cyan_DM_id_WAHX_9y_Gx_0_ea75d58006.webp",
      hash: MEDIA_HASHES[0],
      caption: "E2E storefront cover image",
      width: 512,
      height: 512,
      mime: "image/webp",
      sizeKb: 22.34,
    },
    {
      name: "e2e-storefront-detail.webp",
      fileName: "Cyan_DM_id_WAHX_9y_Gx_0_ea75d58006.webp",
      hash: MEDIA_HASHES[1],
      caption: "E2E storefront detail image",
      width: 512,
      height: 512,
      mime: "image/webp",
      sizeKb: 22.34,
    },
  ],
  colors: [
    {
      title: "E2E Blue",
      colorCode: "#0057ff",
      externalId: "e2e-storefront:color:blue",
    },
    {
      title: "E2E No Hex",
      colorCode: null,
      externalId: "e2e-storefront:color:no-hex",
    },
    {
      title: "E2E Unavailable Black",
      colorCode: "#111111",
      externalId: "e2e-storefront:color:black",
    },
  ],
  sizes: [
    {
      title: "E2E Medium",
      externalId: "e2e-storefront:size:medium",
    },
    {
      title: "E2E Large",
      externalId: "e2e-storefront:size:large",
    },
  ],
  model: {
    title: "E2E Standard",
    externalId: "e2e-storefront:model:standard",
  },
  variations: [
    {
      sku: "E2E-STOREFRONT-BLUE-M",
      price: "1200000",
      discountPrice: "990000",
      stock: 5,
      colorIndex: 0,
      sizeIndex: 0,
      externalId: "e2e-storefront:variation:blue-m",
    },
    {
      sku: "E2E-STOREFRONT-NOHEX-M",
      price: "1300000",
      discountPrice: null,
      stock: 3,
      colorIndex: 1,
      sizeIndex: 0,
      externalId: "e2e-storefront:variation:nohex-m",
    },
    {
      sku: "E2E-STOREFRONT-BLACK-L",
      price: "1400000",
      discountPrice: null,
      stock: 0,
      colorIndex: 2,
      sizeIndex: 1,
      externalId: "e2e-storefront:variation:black-l",
    },
    {
      // Dedicated high-stock variation for payment flows (blue / large, in stock).
      sku: "E2E-STOREFRONT-PAY",
      price: "500000",
      discountPrice: null,
      stock: 99,
      colorIndex: 0,
      sizeIndex: 1,
      externalId: "e2e-storefront:variation:pay",
    },
  ],
  shipping: {
    // The checkout DeliveryOptions filter only surfaces methods whose title
    // contains a recognized keyword (پست/تیپاکس for general cities, پیک/حضوری for
    // Gorgan). Seed one of each branch, marked "(E2E)" for safe teardown, so a
    // selectable shipping method exists no matter which city the address resolves to.
    marker: "(E2E)",
    methods: [
      { title: "پست پیشتاز (E2E)", price: 40000 },
      { title: "ارسال با پیک (E2E)", price: 50000 },
    ],
  },
  address: {
    postalCode: "1234567890",
    fullAddress: "E2E deterministic address, plaque 1",
    description: "E2E seeded address",
  },
  auth: {
    customer: {
      phone: envOrDefault("E2E_CUSTOMER_PHONE", "+989000000101"),
      password: envOrDefault("E2E_CUSTOMER_PASSWORD", "E2eCustomer!123"),
      email: "e2e.customer@infinitycolor.local",
      firstName: "E2E",
      lastName: "Customer",
      roleName: "Customer",
      externalId: "e2e-storefront:user:customer",
      walletBalanceIrr: 50_000_000,
    },
    // A second, unrelated Customer used to assert cross-user ownership scoping
    // (BOLA regression coverage) on address / wallet-transaction endpoints.
    customerB: {
      phone: envOrDefault("E2E_CUSTOMER_B_PHONE", "+989000000109"),
      password: envOrDefault("E2E_CUSTOMER_B_PASSWORD", "E2eCustomerB!123"),
      email: "e2e.customerb@infinitycolor.local",
      firstName: "E2E",
      lastName: "CustomerB",
      roleName: "Customer",
      externalId: "e2e-storefront:user:customer-b",
    },
    admin: {
      phone: envOrDefault("E2E_ADMIN_PHONE", "+989000000201"),
      password: envOrDefault("E2E_ADMIN_PASSWORD", "E2eAdmin!123"),
      email: "e2e.admin@infinitycolor.local",
      firstName: "E2E",
      lastName: "Admin",
      roleName: "Superadmin",
      externalId: "e2e-storefront:user:admin",
    },
    founder: {
      phone: envOrDefault("E2E_FOUNDER_PHONE", "+989000000202"),
      password: envOrDefault("E2E_FOUNDER_PASSWORD", "E2eFounder!123"),
      email: "e2e.founder@infinitycolor.local",
      firstName: "E2E",
      lastName: "Founder",
      roleName: "Founder",
      externalId: "e2e-storefront:user:founder",
      optional: true,
    },
    storeManager: {
      phone: envOrDefault("E2E_STORE_MANAGER_PHONE", "+989000000203"),
      password: envOrDefault("E2E_STORE_MANAGER_PASSWORD", "E2eManager!123"),
      email: "e2e.manager@infinitycolor.local",
      firstName: "E2E",
      lastName: "Manager",
      roleName: "Store manager",
      externalId: "e2e-storefront:user:store-manager",
      optional: true,
    },
    editor: {
      phone: envOrDefault("E2E_EDITOR_PHONE", "+989000000204"),
      password: envOrDefault("E2E_EDITOR_PASSWORD", "E2eEditor!123"),
      email: "e2e.editor@infinitycolor.local",
      firstName: "E2E",
      lastName: "Editor",
      roleName: "Editor",
      externalId: "e2e-storefront:user:editor",
      optional: true,
    },
  },
  adminCategory: {
    slug: ADMIN_CATEGORY_SLUG_PREFIX,
    updatedSlug: `${ADMIN_CATEGORY_SLUG_PREFIX}-updated`,
  },
  gateways: [
    {
      title: "Wallet",
      description: `${TAG}:gateway:wallet`,
    },
    {
      title: "ZarinPal",
      description: `${TAG}:gateway:zarinpal`,
    },
  ],
};

function dbClient() {
  return new Client({
    host: process.env.DATABASE_HOST || "127.0.0.1",
    port: Number(process.env.DATABASE_PORT || process.env.POSTGRES_PORT || 5432),
    database: process.env.DATABASE_NAME || process.env.POSTGRES_DB || "infinity_local",
    user: process.env.DATABASE_USERNAME || process.env.POSTGRES_USER || "infinity",
    password: process.env.DATABASE_PASSWORD || process.env.POSTGRES_PASSWORD || "infinity123",
  });
}

function assertSafeDatabase(force) {
  if (force) return;

  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const database = String(process.env.DATABASE_NAME || process.env.POSTGRES_DB || "infinity_local");
  const host = String(process.env.DATABASE_HOST || "127.0.0.1");
  const explicitAllow = process.env.E2E_ALLOW_NON_ISOLATED_DB === "1";
  const looksProd = /prod|production|staging/i.test(database) || nodeEnv === "production";
  const looksLocalOrTest = /(^|[-_])(local|test|e2e)([-_]|$)/i.test(database);
  const looksLocalHost = /^(localhost|127\.0\.0\.1|::1|postgres|db)$/i.test(host);

  if (looksProd || (!explicitAllow && (!looksLocalOrTest || !looksLocalHost))) {
    console.error(
      `[seed:e2e] Refusing to run against database "${database}" on host "${host}". ` +
        "Use a local/test DB or set E2E_ALLOW_NON_ISOLATED_DB=1 only for a known-safe isolated DB.",
    );
    process.exit(1);
  }
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function tableMeta(client, table) {
  const result = await client.query(
    `SELECT column_name, is_nullable, column_default, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return result.rows;
}

async function tableExists(client, table) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return result.rowCount > 0;
}

async function insertRow(client, table, data) {
  const meta = await tableMeta(client, table);
  if (meta.length === 0) {
    throw new Error(`Table not found: ${table}`);
  }

  const available = new Set(meta.map((column) => column.column_name));
  const entries = Object.entries(data).filter(([column]) => available.has(column));
  const names = entries.map(([column]) => column);
  const values = entries.map(([, value]) => value);
  const params = values.map((_, index) => `$${index + 1}`);

  const result = await client.query(
    `INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(", ")})
     VALUES (${params.join(", ")})
     RETURNING id`,
    values,
  );

  return result.rows[0];
}

async function insertLink(client, table, data) {
  const meta = await tableMeta(client, table);
  if (meta.length === 0) {
    throw new Error(`Link table not found: ${table}`);
  }

  const available = new Map(meta.map((column) => [column.column_name, column]));
  const row = { ...data };

  for (const column of meta) {
    if (
      row[column.column_name] === undefined &&
      column.is_nullable === "NO" &&
      !column.column_default &&
      column.column_name !== "id"
    ) {
      if (column.column_name === "order" || column.column_name.endsWith("_order")) {
        row[column.column_name] = 1;
      }
    }
  }

  const entries = Object.entries(row).filter(([column]) => available.has(column));
  const names = entries.map(([column]) => column);
  const values = entries.map(([, value]) => value);
  const params = values.map((_, index) => `$${index + 1}`);

  await client.query(
    `INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(", ")})
     VALUES (${params.join(", ")})
     ON CONFLICT DO NOTHING`,
    values,
  );
}

async function seedNavigationSingleton(client, productCategoryId, now) {
  if (
    !(await tableExists(client, "navigations")) ||
    !(await tableExists(client, "navigations_product_categories_links"))
  ) {
    return null;
  }

  const existing = await client.query(`SELECT id FROM navigations ORDER BY id ASC LIMIT 1`);
  const navigation =
    existing.rows[0] ||
    (await insertRow(client, "navigations", {
      created_at: now,
      updated_at: now,
    }));

  await insertLink(client, "navigations_product_categories_links", {
    navigation_id: navigation.id,
    product_category_id: productCategoryId,
    product_category_order: 1,
  });

  return navigation.id;
}

async function seedHomepageProductSettings(client, productId, now) {
  if (!(await tableExists(client, "site_settings"))) return [];

  const meta = await tableMeta(client, "site_settings");
  const available = new Set(meta.map((column) => column.column_name));
  if (!available.has("home_newest_product_ids")) return [];

  const payload = JSON.stringify([productId]);
  const newestColumn = meta.find((item) => item.column_name === "home_newest_product_ids");
  const newestJsonCast = newestColumn?.data_type === "json" ? "::json" : "::jsonb";
  const discountedColumn = meta.find(
    (item) => item.column_name === "home_discounted_product_ids",
  );
  const discountedJsonCast =
    discountedColumn?.data_type === "json" ? "::json" : "::jsonb";
  const productIdAssignments = [
    `home_newest_product_ids = $1${newestJsonCast}`,
  ];
  if (discountedColumn) {
    productIdAssignments.push(
      `home_discounted_product_ids = $1${discountedJsonCast}`,
    );
  }
  const existing = await client.query(`SELECT id FROM site_settings ORDER BY id ASC LIMIT 1`);
  const updatedAtClause = available.has("updated_at") ? `, updated_at = $2` : "";

  if (existing.rowCount > 0) {
    const params = available.has("updated_at")
      ? [payload, now, existing.rows[0].id]
      : [payload, existing.rows[0].id];
    const idParam = available.has("updated_at") ? "$3" : "$2";
    await client.query(
      `UPDATE site_settings
       SET ${productIdAssignments.join(", ")}${updatedAtClause}
       WHERE id = ${idParam}`,
      params,
    );
    console.log(
      `[seed:e2e] Curated homepage newest and discounted product ids: [${productId}].`,
    );
    return [productId];
  }

  const names = ["home_newest_product_ids"];
  const values = [payload];
  const params = [`$1${newestJsonCast}`];

  if (discountedColumn) {
    names.push("home_discounted_product_ids");
    params.push(`$1${discountedJsonCast}`);
  }

  if (available.has("created_at")) {
    names.push("created_at");
    values.push(now);
    params.push(`$${values.length}`);
  }
  if (available.has("updated_at")) {
    names.push("updated_at");
    values.push(now);
    params.push(`$${values.length}`);
  }

  await client.query(
    `INSERT INTO site_settings (${names.map(quoteIdent).join(", ")})
     VALUES (${params.join(", ")})`,
    values,
  );
  console.log(
    `[seed:e2e] Curated homepage newest and discounted product ids: [${productId}].`,
  );
  return [productId];
}

async function seedAdaptiveHeroSettings(client, now) {
  if (!(await tableExists(client, "site_settings"))) return false;

  const meta = await tableMeta(client, "site_settings");
  const available = new Map(meta.map((column) => [column.column_name, column]));
  const requiredColumns = [
    "home_hero_slider_draft",
    "home_hero_slider_published",
    "home_hero_slider_meta",
  ];
  if (requiredColumns.some((column) => !available.has(column))) return false;

  const existing = await client.query(`SELECT id FROM site_settings ORDER BY id ASC LIMIT 1`);
  if (existing.rowCount === 0) return false;

  const payload = {
    version: 3,
    autoplayIntervalMs: 600000,
    slides: [
      {
        id: "e2e-adaptive-hero",
        imageUrl: `/uploads/${FIXTURE_UPLOAD_FILE}`,
        imageAlt: "E2E adaptive quality hero",
        mobileImageUrl: `/uploads/${FIXTURE_UPLOAD_FILE}`,
        mobileImageAlt: "E2E adaptive quality hero",
        link: {
          type: "internal",
          href: `/pdp/${FIXTURE.product.slug}`,
        },
        isActive: true,
        autoplayEligible: false,
        order: 0,
        schedule: {
          timezone: "Asia/Tehran",
        },
        tracking: {
          campaign: "e2e-adaptive-quality",
          source: "e2e",
          medium: "test",
          content: "hero",
          custom: {},
        },
      },
    ],
  };
  const publishedMeta = {
    version: 3,
    publishedAt: now.toISOString(),
    publishedBy: null,
  };
  const values = [payload, payload, publishedMeta].map(JSON.stringify);
  const casts = requiredColumns.map((column) =>
    available.get(column)?.data_type === "json" ? "::json" : "::jsonb",
  );
  const updatedAtClause = available.has("updated_at") ? ", updated_at = $4" : "";
  const params = available.has("updated_at")
    ? [...values, now, existing.rows[0].id]
    : [...values, existing.rows[0].id];
  const idParam = available.has("updated_at") ? "$5" : "$4";

  await client.query(
    `UPDATE site_settings
     SET home_hero_slider_draft = $1${casts[0]},
         home_hero_slider_published = $2${casts[1]},
         home_hero_slider_meta = $3${casts[2]}${updatedAtClause}
     WHERE id = ${idParam}`,
    params,
  );
  console.log("[seed:e2e] Published deterministic adaptive-quality hero.");
  return true;
}

async function idsBySource(client, table) {
  if (!(await tableExists(client, table))) return [];
  const result = await client.query(
    `SELECT id FROM ${quoteIdent(table)} WHERE external_source = $1 OR external_id LIKE $2`,
    [TAG, `${TAG}:%`],
  );
  return result.rows.map((row) => Number(row.id)).filter(Number.isFinite);
}

async function mediaIds(client) {
  if (!(await tableExists(client, "files"))) return [];
  const result = await client.query(`SELECT id FROM files WHERE hash = ANY($1::text[])`, [
    MEDIA_HASHES,
  ]);
  return result.rows.map((row) => Number(row.id)).filter(Number.isFinite);
}

async function deleteWhereIn(client, table, column, ids) {
  if (!ids.length || !(await tableExists(client, table))) return;
  await client.query(
    `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} = ANY($1::int[])`,
    [ids],
  );
}

async function idsFromLink(client, table, selectColumn, filterColumn, ids) {
  if (!ids.length || !(await tableExists(client, table))) return [];
  const result = await client.query(
    `SELECT ${quoteIdent(selectColumn)} AS id
     FROM ${quoteIdent(table)}
     WHERE ${quoteIdent(filterColumn)} = ANY($1::int[])`,
    [ids],
  );
  return result.rows.map((row) => Number(row.id)).filter(Number.isFinite);
}

async function deleteBySource(client, table) {
  if (!(await tableExists(client, table))) return;
  await client.query(
    `DELETE FROM ${quoteIdent(table)} WHERE external_source = $1 OR external_id LIKE $2`,
    [TAG, `${TAG}:%`],
  );
}

async function e2eUserIds(client) {
  if (!(await tableExists(client, "users"))) return [];
  const fixturePhones = [
    FIXTURE.auth.customer.phone,
    FIXTURE.auth.customerB.phone,
    FIXTURE.auth.admin.phone,
  ];
  const result = await client.query(
    `SELECT id FROM users
     WHERE external_source = $1
        OR external_id LIKE $2
        OR phone = ANY($3::text[])`,
    [TAG, `${TAG}:user:%`, fixturePhones],
  );
  return result.rows.map((row) => Number(row.id)).filter(Number.isFinite);
}

async function teardownUserData(client, userIds) {
  if (!userIds.length) return;

  const cartIds = await idsFromLink(client, "carts_user_links", "cart_id", "user_id", userIds);
  const cartItemIds = await idsFromLink(
    client,
    "cart_items_cart_links",
    "cart_item_id",
    "cart_id",
    cartIds,
  );
  await deleteWhereIn(client, "cart_items_product_variation_links", "cart_item_id", cartItemIds);
  await deleteWhereIn(client, "cart_items_cart_links", "cart_item_id", cartItemIds);
  await deleteWhereIn(client, "cart_items", "id", cartItemIds);
  await deleteWhereIn(client, "carts_user_links", "user_id", userIds);
  await deleteWhereIn(client, "carts", "id", cartIds);

  const guestMergeIds = await idsFromLink(
    client,
    "guest_cart_merges_user_links",
    "guest_cart_merge_id",
    "user_id",
    userIds,
  );
  await deleteWhereIn(client, "guest_cart_merges_user_links", "user_id", userIds);
  await deleteWhereIn(client, "guest_cart_merges", "id", guestMergeIds);

  const paymentAttemptIds = await idsFromLink(
    client,
    "payment_attempts_user_links",
    "payment_attempt_id",
    "user_id",
    userIds,
  );
  await deleteWhereIn(
    client,
    "payment_attempts_order_links",
    "payment_attempt_id",
    paymentAttemptIds,
  );
  await deleteWhereIn(
    client,
    "payment_attempts_contract_links",
    "payment_attempt_id",
    paymentAttemptIds,
  );
  await deleteWhereIn(client, "payment_attempts_user_links", "user_id", userIds);
  await deleteWhereIn(client, "payment_attempts", "id", paymentAttemptIds);

  const orderIds = await idsFromLink(client, "orders_user_links", "order_id", "user_id", userIds);
  const orderItemIds = await idsFromLink(
    client,
    "order_items_order_links",
    "order_item_id",
    "order_id",
    orderIds,
  );
  await deleteWhereIn(client, "order_items_product_color_links", "order_item_id", orderItemIds);
  await deleteWhereIn(client, "order_items_product_size_links", "order_item_id", orderItemIds);
  await deleteWhereIn(client, "order_items_product_variation_links", "order_item_id", orderItemIds);
  await deleteWhereIn(
    client,
    "order_items_product_variation_model_links",
    "order_item_id",
    orderItemIds,
  );
  await deleteWhereIn(client, "order_items_order_links", "order_item_id", orderItemIds);
  await deleteWhereIn(client, "order_items", "id", orderItemIds);
  const orderLogIds = await idsFromLink(
    client,
    "order_logs_order_links",
    "order_log_id",
    "order_id",
    orderIds,
  );
  await deleteWhereIn(client, "order_logs_performed_by_links", "order_log_id", orderLogIds);
  await deleteWhereIn(client, "order_logs_order_links", "order_id", orderIds);
  await deleteWhereIn(client, "order_logs", "id", orderLogIds);
  await deleteWhereIn(client, "orders_contract_links", "order_id", orderIds);
  await deleteWhereIn(client, "orders_delivery_address_links", "order_id", orderIds);
  await deleteWhereIn(client, "orders_shipping_links", "order_id", orderIds);
  await deleteWhereIn(client, "orders_user_links", "user_id", userIds);
  await deleteWhereIn(client, "orders", "id", orderIds);

  const contractIds = await idsFromLink(
    client,
    "contracts_local_user_links",
    "contract_id",
    "user_id",
    userIds,
  );
  const contractTransactionIds = await idsFromLink(
    client,
    "contract_transactions_contract_links",
    "contract_transaction_id",
    "contract_id",
    contractIds,
  );
  await deleteWhereIn(
    client,
    "contract_transactions_payment_gateway_links",
    "contract_transaction_id",
    contractTransactionIds,
  );
  await deleteWhereIn(client, "contract_transactions_contract_links", "contract_id", contractIds);
  await deleteWhereIn(client, "contract_transactions", "id", contractTransactionIds);
  await deleteWhereIn(client, "contract_logs_contract_links", "contract_id", contractIds);
  await deleteWhereIn(client, "contracts_local_user_links", "user_id", userIds);
  await deleteWhereIn(client, "contracts", "id", contractIds);

  const addressIds = await idsFromLink(
    client,
    "local_user_addresses_user_links",
    "local_user_address_id",
    "user_id",
    userIds,
  );
  await deleteWhereIn(
    client,
    "local_user_addresses_shipping_city_links",
    "local_user_address_id",
    addressIds,
  );
  await deleteWhereIn(client, "local_user_addresses_user_links", "user_id", userIds);
  await deleteWhereIn(client, "local_user_addresses", "id", addressIds);

  const infoIds = await idsFromLink(
    client,
    "local_user_infos_user_links",
    "local_user_info_id",
    "user_id",
    userIds,
  );
  const walletIds = await idsFromLink(
    client,
    "local_user_wallets_user_links",
    "local_user_wallet_id",
    "user_id",
    userIds,
  );
  const walletTransactionIds = await idsFromLink(
    client,
    "local_user_wallet_transactions_user_wallet_links",
    "local_user_wallet_transaction_id",
    "local_user_wallet_id",
    walletIds,
  );
  await deleteWhereIn(
    client,
    "local_user_wallet_transactions_user_wallet_links",
    "local_user_wallet_transaction_id",
    walletTransactionIds,
  );
  await deleteWhereIn(client, "local_user_wallet_transactions", "id", walletTransactionIds);
  await deleteWhereIn(client, "local_user_infos_user_links", "user_id", userIds);
  await deleteWhereIn(client, "local_user_infos", "id", infoIds);
  await deleteWhereIn(client, "local_user_wallets_user_links", "user_id", userIds);
  await deleteWhereIn(client, "local_user_wallets", "id", walletIds);
  await deleteWhereIn(client, "users_role_links", "user_id", userIds);
  await deleteWhereIn(client, "users_user_role_links", "user_id", userIds);
  await deleteWhereIn(client, "users", "id", userIds);
}

async function deleteAdminCrudCategories(client) {
  if (!(await tableExists(client, "product_categories"))) return;

  const result = await client.query(
    `SELECT id FROM product_categories
     WHERE slug = ANY($1::text[])
        OR slug LIKE $2`,
    [
      [FIXTURE.adminCategory.slug, FIXTURE.adminCategory.updatedSlug],
      `${ADMIN_CATEGORY_SLUG_PREFIX}%`,
    ],
  );
  const categoryIds = result.rows.map((row) => Number(row.id)).filter(Number.isFinite);
  if (!categoryIds.length) return;

  await deleteWhereIn(
    client,
    "products_product_main_category_links",
    "product_category_id",
    categoryIds,
  );
  await deleteWhereIn(
    client,
    "products_product_other_categories_links",
    "product_category_id",
    categoryIds,
  );
  await deleteWhereIn(
    client,
    "product_categories_parent_links",
    "product_category_id",
    categoryIds,
  );
  await deleteWhereIn(
    client,
    "product_categories_parent_links",
    "inv_product_category_id",
    categoryIds,
  );
  await deleteWhereIn(client, "product_categories", "id", categoryIds);
}

async function deleteShippingMethod(client) {
  if (!(await tableExists(client, "shippings"))) return;
  const result = await client.query(`SELECT id FROM shippings WHERE title LIKE $1`, [
    `%${FIXTURE.shipping.marker}%`,
  ]);
  const shippingIds = result.rows.map((row) => Number(row.id)).filter(Number.isFinite);
  if (!shippingIds.length) return;
  await deleteWhereIn(client, "orders_shipping_links", "shipping_id", shippingIds);
  await deleteWhereIn(client, "shippings", "id", shippingIds);
}

async function deleteSeededPaymentGateways(client) {
  if (!(await tableExists(client, "payment_gateways"))) return;
  await client.query(`DELETE FROM payment_gateways WHERE description = ANY($1::text[])`, [
    FIXTURE.gateways.map((gateway) => gateway.description),
  ]);
}

async function teardown(client) {
  const userIds = await e2eUserIds(client);
  const productIds = await idsBySource(client, "products");
  const variationIds = await idsBySource(client, "product_variations");
  const stockIds = await idsBySource(client, "product_stocks");
  const colorIds = await idsBySource(client, "product_variation_colors");
  const sizeIds = await idsBySource(client, "product_variation_sizes");
  const modelIds = await idsBySource(client, "product_variation_models");
  const fileIds = await mediaIds(client);

  await teardownUserData(client, userIds);
  await deleteShippingMethod(client);
  await deleteSeededPaymentGateways(client);
  await deleteAdminCrudCategories(client);
  await deleteWhereIn(client, "files_related_morphs", "related_id", productIds);
  await deleteWhereIn(client, "files_related_morphs", "file_id", fileIds);
  await deleteWhereIn(client, "products_product_main_category_links", "product_id", productIds);
  await deleteWhereIn(client, "products_product_other_categories_links", "product_id", productIds);
  await deleteWhereIn(
    client,
    "product_variations_product_links",
    "product_variation_id",
    variationIds,
  );
  await deleteWhereIn(
    client,
    "product_variations_product_stock_links",
    "product_variation_id",
    variationIds,
  );
  await deleteWhereIn(
    client,
    "product_variations_product_variation_color_links",
    "product_variation_id",
    variationIds,
  );
  await deleteWhereIn(
    client,
    "product_variations_product_variation_size_links",
    "product_variation_id",
    variationIds,
  );
  await deleteWhereIn(
    client,
    "product_variations_product_variation_model_links",
    "product_variation_id",
    variationIds,
  );

  await deleteBySource(client, "product_variations");
  await deleteBySource(client, "product_stocks");
  await deleteBySource(client, "products");
  await deleteBySource(client, "product_categories");
  await deleteBySource(client, "product_variation_colors");
  await deleteBySource(client, "product_variation_sizes");
  await deleteBySource(client, "product_variation_models");

  if (fileIds.length && (await tableExists(client, "files"))) {
    await client.query(`DELETE FROM files WHERE id = ANY($1::int[])`, [fileIds]);
  }
}

async function roleIdByName(client, roleName) {
  if (!(await tableExists(client, "up_roles"))) {
    throw new Error("users-permissions roles table not found");
  }

  const result = await client.query(
    `SELECT id FROM up_roles WHERE lower(name) = lower($1) LIMIT 1`,
    [roleName],
  );
  const roleId = Number(result.rows[0]?.id);
  if (!Number.isFinite(roleId)) {
    throw new Error(`Required E2E role not found: ${roleName}`);
  }
  return roleId;
}

async function roleIdByNameOptional(client, roleName) {
  if (!(await tableExists(client, "up_roles"))) return null;
  const result = await client.query(
    `SELECT id FROM up_roles WHERE lower(name) = lower($1) LIMIT 1`,
    [roleName],
  );
  const roleId = Number(result.rows[0]?.id);
  return Number.isFinite(roleId) ? roleId : null;
}

async function ensureRolePermission(client, roleName, action, now) {
  const roleId = await roleIdByName(client, roleName);
  let permissionId = Number(
    (await client.query(`SELECT id FROM up_permissions WHERE action = $1 LIMIT 1`, [action]))
      .rows[0]?.id,
  );

  if (!Number.isFinite(permissionId)) {
    const permission = await insertRow(client, "up_permissions", {
      action,
      created_at: now,
      updated_at: now,
    });
    permissionId = permission.id;
  }

  await insertLink(client, "up_permissions_role_links", {
    permission_id: permissionId,
    role_id: roleId,
  });
}

async function ensureE2ERolePermissions(client, now) {
  await ensureRolePermission(
    client,
    FIXTURE.auth.customer.roleName,
    "api::order.order.getActiveReserve",
    now,
  );
}

async function seedUser(client, userDef, now) {
  const roleId = await roleIdByName(client, userDef.roleName);
  const passwordHash = await bcrypt.hash(userDef.password, 10);
  const user = await insertRow(client, "users", {
    username: userDef.phone,
    email: userDef.email,
    provider: "local",
    password: passwordHash,
    confirmed: true,
    blocked: false,
    phone: userDef.phone,
    is_verified: true,
    is_active: true,
    external_id: userDef.externalId,
    external_source: TAG,
    created_at: now,
    updated_at: now,
  });

  await insertLink(client, "users_role_links", {
    user_id: user.id,
    role_id: roleId,
  });

  const profile = await insertRow(client, "local_user_infos", {
    first_name: userDef.firstName,
    last_name: userDef.lastName,
    created_at: now,
    updated_at: now,
  });
  await insertLink(client, "local_user_infos_user_links", {
    local_user_info_id: profile.id,
    user_id: user.id,
  });

  const wallet = await insertRow(client, "local_user_wallets", {
    balance: String(userDef.walletBalanceIrr || 0),
    last_transaction_date: now,
    description: "E2E fixture wallet",
    created_at: now,
    updated_at: now,
  });
  await insertLink(client, "local_user_wallets_user_links", {
    local_user_wallet_id: wallet.id,
    user_id: user.id,
  });

  return { id: user.id, roleId };
}

async function seedUsers(client, now) {
  const customer = await seedUser(client, FIXTURE.auth.customer, now);
  const customerB = await seedUser(client, FIXTURE.auth.customerB, now);
  const admin = await seedUser(client, FIXTURE.auth.admin, now);

  // Role-specific users power the permission/CRUD suites. They are optional so a
  // backend whose bootstrap has not yet created these roles still seeds cleanly.
  const optionalRoles = {};
  for (const [key, userDef] of [
    ["founder", FIXTURE.auth.founder],
    ["storeManager", FIXTURE.auth.storeManager],
    ["editor", FIXTURE.auth.editor],
  ]) {
    const roleId = await roleIdByNameOptional(client, userDef.roleName);
    if (!roleId) {
      console.warn(
        `[seed:e2e] Role "${userDef.roleName}" not found; skipping ${key} user. ` +
          "Permission tests for this role will be unavailable until the backend bootstrap creates it.",
      );
      optionalRoles[key] = null;
      continue;
    }
    optionalRoles[key] = await seedUser(client, userDef, now);
  }

  return { customer, customerB, admin, ...optionalRoles };
}

async function walletIdForUser(client, userId) {
  const result = await client.query(
    `SELECT local_user_wallet_id AS id FROM local_user_wallets_user_links WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const walletId = Number(result.rows[0]?.id);
  if (!Number.isFinite(walletId)) {
    throw new Error(`No wallet found for seeded user ${userId}`);
  }
  return walletId;
}

async function seedWalletTransaction(client, walletId, now) {
  const transaction = await insertRow(client, "local_user_wallet_transactions", {
    amount: "500000",
    type: "Add",
    date: now,
    cause: "E2E fixture top-up",
    reference_id: `${TAG}:wallet-transaction:${walletId}`,
    note: "e2e",
    description: "E2E seeded wallet transaction",
    created_at: now,
    updated_at: now,
  });
  await insertLink(client, "local_user_wallet_transactions_user_wallet_links", {
    local_user_wallet_transaction_id: transaction.id,
    local_user_wallet_id: walletId,
  });
  return { id: transaction.id };
}

async function firstShippingCityId(client) {
  if (!(await tableExists(client, "shipping_cities"))) return null;
  const result = await client.query(`SELECT id FROM shipping_cities ORDER BY id ASC LIMIT 1`);
  const cityId = Number(result.rows[0]?.id);
  return Number.isFinite(cityId) ? cityId : null;
}

async function seedShippingMethods(client, now) {
  const ids = [];
  for (const method of FIXTURE.shipping.methods) {
    const shipping = await insertRow(client, "shippings", {
      title: method.title,
      price: method.price,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    ids.push(shipping.id);
  }
  return ids;
}

async function seedPaymentGateways(client, now) {
  if (!(await tableExists(client, "payment_gateways"))) {
    throw new Error("Table not found: payment_gateways");
  }

  const gateways = [];
  for (const gateway of FIXTURE.gateways) {
    const existing = await client.query(
      `SELECT id FROM payment_gateways WHERE lower(title) = lower($1) LIMIT 1`,
      [gateway.title],
    );
    if (existing.rowCount > 0) {
      throw new Error(
        `E2E ${gateway.title} gateway conflicts with existing payment gateway id ${existing.rows[0].id}`,
      );
    }
    gateways.push(
      await insertRow(client, "payment_gateways", {
        title: gateway.title,
        description: gateway.description,
        is_active: true,
        created_at: now,
        updated_at: now,
      }),
    );
  }
  return gateways;
}

async function seedCustomerAddress(client, userId, now) {
  const cityId = await firstShippingCityId(client);
  const address = await insertRow(client, "local_user_addresses", {
    postal_code: FIXTURE.address.postalCode,
    full_address: FIXTURE.address.fullAddress,
    description: FIXTURE.address.description,
    is_temporary: false,
    created_at: now,
    updated_at: now,
  });

  if (await tableExists(client, "local_user_addresses_user_links")) {
    await insertLink(client, "local_user_addresses_user_links", {
      local_user_address_id: address.id,
      user_id: userId,
    });
  }
  if (cityId && (await tableExists(client, "local_user_addresses_shipping_city_links"))) {
    await insertLink(client, "local_user_addresses_shipping_city_links", {
      local_user_address_id: address.id,
      shipping_city_id: cityId,
    });
  }

  return { id: address.id, cityId };
}

async function seedCustomerCart(client, userId, variationId, now) {
  const cart = await insertRow(client, "carts", {
    status: "Pending",
    created_at: now,
    updated_at: now,
  });
  await insertLink(client, "carts_user_links", {
    cart_id: cart.id,
    user_id: userId,
  });

  const firstVariation = FIXTURE.variations[0];
  const item = await insertRow(client, "cart_items", {
    sum: firstVariation.discountPrice || firstVariation.price,
    count: 1,
    created_at: now,
    updated_at: now,
  });
  await insertLink(client, "cart_items_cart_links", {
    cart_item_id: item.id,
    cart_id: cart.id,
    cart_item_order: 1,
  });
  await insertLink(client, "cart_items_product_variation_links", {
    cart_item_id: item.id,
    product_variation_id: variationId,
  });

  return { id: cart.id, itemId: item.id };
}

async function seed(client) {
  const now = new Date();
  await ensureE2ERolePermissions(client, now);

  const category = await insertRow(client, "product_categories", {
    title: FIXTURE.category.title,
    slug: FIXTURE.category.slug,
    color: "#0057ff",
    is_main_category: true,
    featured: true,
    external_id: FIXTURE.category.externalId,
    external_source: TAG,
    created_at: now,
    updated_at: now,
  });
  await seedNavigationSingleton(client, category.id, now);

  const product = await insertRow(client, "products", {
    title: FIXTURE.product.title,
    slug: FIXTURE.product.slug,
    weight: 100,
    description: "<p>Deterministic E2E storefront smoke product.</p>",
    status: "Active",
    product_type: "Variable",
    is_simple_product: false,
    average_rating: 5,
    rating_count: 1,
    seen_count: 777,
    external_id: FIXTURE.product.externalId,
    external_source: TAG,
    created_at: now,
    updated_at: now,
  });
  const homepageNewestProductIds = await seedHomepageProductSettings(client, product.id, now);
  await seedAdaptiveHeroSettings(client, now);

  await insertLink(client, "products_product_main_category_links", {
    product_id: product.id,
    product_category_id: category.id,
  });

  const media = [];
  for (const mediaDef of FIXTURE.media) {
    const mediaUrl = `/uploads/${mediaDef.fileName}`;
    media.push(
      await insertRow(client, "files", {
        name: mediaDef.name,
        alternative_text: FIXTURE.product.title,
        caption: mediaDef.caption,
        width: mediaDef.width,
        height: mediaDef.height,
        formats: {
          thumbnail: {
            url: mediaUrl,
            width: mediaDef.width,
            height: mediaDef.height,
          },
        },
        hash: mediaDef.hash,
        ext: ".webp",
        mime: mediaDef.mime,
        size: mediaDef.sizeKb,
        url: mediaUrl,
        provider: "local",
        provider_metadata: null,
        folder_path: "/",
        created_at: now,
        updated_at: now,
      }),
    );
  }

  await insertLink(client, "files_related_morphs", {
    file_id: media[0].id,
    related_id: product.id,
    related_type: "api::product.product",
    field: "CoverImage",
    order: 1,
  });
  await insertLink(client, "files_related_morphs", {
    file_id: media[1].id,
    related_id: product.id,
    related_type: "api::product.product",
    field: "Media",
    order: 1,
  });

  const colors = [];
  for (const color of FIXTURE.colors) {
    colors.push(
      await insertRow(client, "product_variation_colors", {
        title: color.title,
        color_code: color.colorCode,
        external_id: color.externalId,
        external_source: TAG,
        created_at: now,
        updated_at: now,
      }),
    );
  }

  const sizes = [];
  for (const size of FIXTURE.sizes) {
    sizes.push(
      await insertRow(client, "product_variation_sizes", {
        title: size.title,
        external_id: size.externalId,
        external_source: TAG,
        created_at: now,
        updated_at: now,
      }),
    );
  }

  const model = await insertRow(client, "product_variation_models", {
    title: FIXTURE.model.title,
    external_id: FIXTURE.model.externalId,
    external_source: TAG,
    created_at: now,
    updated_at: now,
  });

  const variations = [];
  for (const variationDef of FIXTURE.variations) {
    const stock = await insertRow(client, "product_stocks", {
      count: variationDef.stock,
      reserved_count: 0,
      external_id: `${variationDef.externalId}:stock`,
      external_source: TAG,
      created_at: now,
      updated_at: now,
    });

    const variation = await insertRow(client, "product_variations", {
      is_published: true,
      sku: variationDef.sku,
      price: variationDef.price,
      discount_price: variationDef.discountPrice,
      external_id: variationDef.externalId,
      external_source: TAG,
      created_at: now,
      updated_at: now,
    });
    variations.push(variation);

    await insertLink(client, "product_variations_product_links", {
      product_variation_id: variation.id,
      product_id: product.id,
    });
    await insertLink(client, "product_variations_product_stock_links", {
      product_variation_id: variation.id,
      product_stock_id: stock.id,
    });
    await insertLink(client, "product_variations_product_variation_color_links", {
      product_variation_id: variation.id,
      product_variation_color_id: colors[variationDef.colorIndex].id,
    });
    await insertLink(client, "product_variations_product_variation_size_links", {
      product_variation_id: variation.id,
      product_variation_size_id: sizes[variationDef.sizeIndex].id,
    });
    await insertLink(client, "product_variations_product_variation_model_links", {
      product_variation_id: variation.id,
      product_variation_model_id: model.id,
    });
  }

  const users = await seedUsers(client, now);
  const customerCart = await seedCustomerCart(client, users.customer.id, variations[0].id, now);
  const customerAddress = await seedCustomerAddress(client, users.customer.id, now);

  // Customer B owns her own address + wallet transaction, unrelated to the primary
  // customer above, so permission specs can assert cross-user access is denied.
  const customerBAddress = await seedCustomerAddress(client, users.customerB.id, now);
  const customerBWalletId = await walletIdForUser(client, users.customerB.id);
  const customerBTransaction = await seedWalletTransaction(client, customerBWalletId, now);

  const shippingIds = await seedShippingMethods(client, now);
  const paymentGateways = await seedPaymentGateways(client, now);

  const paymentVariationIndex = FIXTURE.variations.findIndex(
    (variation) => variation.sku === "E2E-STOREFRONT-PAY",
  );
  const paymentVariationId =
    paymentVariationIndex >= 0 ? variations[paymentVariationIndex].id : null;

  return {
    categoryId: category.id,
    categorySlug: FIXTURE.category.slug,
    productId: product.id,
    productSlug: FIXTURE.product.slug,
    homepageNewestProductIds,
    variationIds: variations.map((variation) => variation.id),
    paymentVariationId,
    customerUserId: users.customer.id,
    customerCartId: customerCart.id,
    customerAddressId: customerAddress.id,
    customerBUserId: users.customerB.id,
    customerBAddressId: customerBAddress.id,
    customerBWalletTransactionId: customerBTransaction.id,
    shippingIds,
    paymentGatewayId: paymentGateways[0].id,
    zarinpalPaymentGatewayId: paymentGateways[1].id,
    adminUserId: users.admin.id,
    founderUserId: users.founder ? users.founder.id : null,
    storeManagerUserId: users.storeManager ? users.storeManager.id : null,
    editorUserId: users.editor ? users.editor.id : null,
  };
}

async function clearEndpointCache() {
  if (process.env.E2E_SKIP_REDIS_CACHE_CLEAR === "1") return;
  if (process.env.E2E_CLEAR_REDIS_CACHE !== "1") return;
  const timeoutMs = Number(process.env.E2E_REDIS_CACHE_CLEAR_TIMEOUT_MS || 3_000);

  try {
    const { createClient } = require("redis");
    const client = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      database: Number(process.env.REDIS_CACHE_DB || process.env.REDIS_DB || 0),
      socket: {
        connectTimeout: timeoutMs,
        reconnectStrategy: false,
      },
    });

    await Promise.race([
      (async () => {
        await client.connect();
        const keys = [];
        for await (const key of client.scanIterator({
          MATCH: "endpoint-cache:product*",
          COUNT: 100,
        })) {
          keys.push(key);
        }
        if (keys.length) {
          await client.del(keys);
        }
        await client.quit();
        console.log(`[seed:e2e] Cleared ${keys.length} product endpoint cache keys.`);
      })(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Redis cache clear timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  } catch (error) {
    console.warn(`[seed:e2e] Redis cache clear skipped: ${error.message}`);
  }
}

async function ensureFixtureUploads() {
  const source = path.resolve(__dirname, "..", "e2e-fixtures/uploads", FIXTURE_UPLOAD_FILE);
  const targetDir = path.resolve(__dirname, "..", "public/uploads");
  const target = path.join(targetDir, FIXTURE_UPLOAD_FILE);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(source, target);
}

async function main() {
  const teardownOnly = process.argv.includes("--teardown");
  const force = process.argv.includes("--force");
  assertSafeDatabase(force);

  const client = dbClient();
  await client.connect();

  let summary = null;
  try {
    await client.query("BEGIN");
    await teardown(client);
    if (!teardownOnly) {
      await ensureFixtureUploads();
      summary = await seed(client);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }

  await clearEndpointCache();

  if (teardownOnly) {
    console.log("[seed:e2e] Storefront fixtures removed.");
    return;
  }

  console.log("[seed:e2e] Storefront fixtures seeded.");
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[seed:e2e] Failed:", error);
    process.exit(1);
  });
}

module.exports = { FIXTURE, TAG };
