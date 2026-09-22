import type { Strapi } from "@strapi/strapi";

/**
 * Database readiness for the wallet money paths.
 *
 * Wallet holds and top-ups both rely on database-enforced uniqueness that this
 * repository did not have: Strapi never turned `unique: true` into an index for
 * `local_user_wallet_transactions.reference_id` or `wallet_topups.sale_order_id`,
 * and nothing stopped a user owning two wallet rows. `wallet-database.ts`
 * installs those objects; this module *verifies* them and is the gate the
 * capability flags are ANDed with.
 *
 * A capability whose prerequisites are missing stays off. It is never enabled on
 * the strength of a log line saying the prerequisite could not be created.
 */

export type WalletReadinessCheck = {
  key: string;
  ok: boolean;
  detail?: string;
};

export type WalletReadiness = {
  evaluatedAt: string;
  holds: boolean;
  topups: boolean;
  checks: WalletReadinessCheck[];
};

const UNKNOWN_READINESS: WalletReadiness = {
  evaluatedAt: new Date(0).toISOString(),
  holds: false,
  topups: false,
  checks: [{ key: "not_evaluated", ok: false, detail: "Readiness has not been evaluated yet" }],
};

let cached: WalletReadiness = UNKNOWN_READINESS;

const truthy = (value?: string): boolean =>
  ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

async function hasColumn(strapi: Strapi, table: string, column: string): Promise<boolean> {
  const result = await strapi.db.connection.raw(
    `SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  );
  return (result?.rows || []).length > 0;
}

async function hasIndex(strapi: Strapi, name: string): Promise<boolean> {
  const result = await strapi.db.connection.raw(
    `SELECT 1
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relkind = 'i'
        AND c.relname = ?
        AND i.indisunique = TRUE
        AND i.indisvalid = TRUE
        AND i.indisready = TRUE
      LIMIT 1`,
    [name],
  );
  return (result?.rows || []).length > 0;
}

async function hasConstraint(strapi: Strapi, name: string): Promise<boolean> {
  const result = await strapi.db.connection.raw(
    `SELECT 1
       FROM pg_constraint
      WHERE conname = ?
        AND contype = 'u'
        AND convalidated = TRUE
      LIMIT 1`,
    [name],
  );
  return (result?.rows || []).length > 0;
}

async function hasTable(strapi: Strapi, table: string): Promise<boolean> {
  const result = await strapi.db.connection.raw(`SELECT to_regclass(?) AS reg`, [table]);
  return Boolean(result?.rows?.[0]?.reg);
}

async function duplicateWalletOwners(strapi: Strapi): Promise<number> {
  const result = await strapi.db.connection.raw(
    `SELECT COUNT(*)::int AS count FROM (
       SELECT user_id FROM local_user_wallets_user_links
       WHERE user_id IS NOT NULL
       GROUP BY user_id HAVING COUNT(*) > 1
     ) duplicates`,
  );
  return Number(result?.rows?.[0]?.count || 0);
}

async function malformedTopupOwners(strapi: Strapi): Promise<number> {
  const result = await strapi.db.connection.raw(
    `SELECT COUNT(*)::int AS count FROM (
       SELECT t.id
         FROM wallet_topups t
         LEFT JOIN wallet_topups_user_links l ON l.wallet_topup_id = t.id
        GROUP BY t.id
       HAVING COUNT(l.user_id) <> 1
     ) malformed`,
  );
  return Number(result?.rows?.[0]?.count || 0);
}

/**
 * Re-reads every prerequisite and caches the verdict. Called from `bootstrap`
 * after `ensureWalletDatabaseInvariants`, and exposed to operators so a data
 * repair can be confirmed without a restart.
 */
export async function refreshWalletReadiness(strapi: Strapi): Promise<WalletReadiness> {
  const client = String(
    (strapi.db.connection as any)?.client?.config?.client || "",
  ).toLowerCase();
  if (!client.includes("pg") && !client.includes("postgres")) {
    cached = {
      evaluatedAt: new Date().toISOString(),
      holds: false,
      topups: false,
      checks: [{ key: "postgres", ok: false, detail: "Wallet money paths require PostgreSQL" }],
    };
    return cached;
  }

  const checks: WalletReadinessCheck[] = [];
  const record = async (key: string, probe: () => Promise<boolean>, detail?: string) => {
    try {
      const ok = await probe();
      checks.push({ key, ok, ...(ok ? {} : { detail }) });
      return ok;
    } catch (error) {
      checks.push({ key, ok: false, detail: String((error as any)?.message || error).slice(0, 200) });
      return false;
    }
  };

  const heldBalance = await record(
    "local_user_wallets.held_balance",
    () => hasColumn(strapi, "local_user_wallets", "held_balance"),
    "column missing",
  );
  const holdColumns = await record(
    "payment_attempts.wallet_hold_status",
    async () =>
      (await hasColumn(strapi, "payment_attempts", "wallet_hold_status")) &&
      (await hasColumn(strapi, "payment_attempts", "wallet_amount")) &&
      (await hasColumn(strapi, "payment_attempts", "gateway_amount")),
    "wallet hold columns missing",
  );
  const oneWalletPerUser = await record(
    "idx_local_user_wallets_one_per_user",
    () => hasIndex(strapi, "idx_local_user_wallets_one_per_user"),
    "unique index missing — a user could own two wallets",
  );
  const noDuplicateWallets = await record(
    "local_user_wallets.duplicate_owners",
    async () => (await duplicateWalletOwners(strapi)) === 0,
    "at least one user owns more than one wallet row",
  );
  const ledgerUnique = await record(
    "idx_wallet_transactions_reference_id",
    () => hasIndex(strapi, "idx_wallet_transactions_reference_id"),
    "ledger reference uniqueness missing",
  );
  const topupTable = await record(
    "wallet_topups",
    () => hasTable(strapi, "wallet_topups"),
    "table missing",
  );
  const topupColumns = await record(
    "wallet_topups.columns",
    async () =>
      (await hasColumn(strapi, "wallet_topups", "amount")) &&
      (await hasColumn(strapi, "wallet_topups", "gateway")) &&
      (await hasColumn(strapi, "wallet_topups", "status")) &&
      (await hasColumn(strapi, "wallet_topups", "sale_order_id")) &&
      (await hasColumn(strapi, "wallet_topups", "ref_id")) &&
      (await hasColumn(strapi, "wallet_topups", "sale_reference_id")) &&
      (await hasColumn(strapi, "wallet_topups", "provider_reference")) &&
      (await hasColumn(strapi, "wallet_topups", "verification_reference")) &&
      (await hasColumn(strapi, "wallet_topups", "expires_at")) &&
      (await hasColumn(strapi, "wallet_topups", "ledger_reference_id")) &&
      (await hasColumn(strapi, "wallet_topups", "idempotency_key")) &&
      (await hasColumn(strapi, "wallet_topups", "redirect_url")) &&
      (await hasColumn(strapi, "wallet_topups", "redirect_method")) &&
      (await hasColumn(strapi, "wallet_topups", "next_reconcile_at")) &&
      (await hasColumn(strapi, "wallet_topups", "reconcile_attempts")) &&
      (await hasColumn(strapi, "wallet_topups", "last_provider_code")) &&
      (await hasColumn(strapi, "wallet_topups", "last_provider_error")),
    "top-up columns missing",
  );
  const topupOwnership = await record(
    "wallet_topups.ownership",
    async () =>
      (await hasTable(strapi, "wallet_topups_user_links")) &&
      (await hasColumn(strapi, "wallet_topups_user_links", "wallet_topup_id")) &&
      (await hasColumn(strapi, "wallet_topups_user_links", "user_id")) &&
      (await hasConstraint(strapi, "wallet_topups_user_links_unique")) &&
      (await hasIndex(strapi, "idx_wallet_topups_one_owner")),
    "top-up ownership link or uniqueness missing",
  );
  const validTopupOwners = await record(
    "wallet_topups.owner_rows",
    async () => (await malformedTopupOwners(strapi)) === 0,
    "at least one top-up does not have exactly one owner",
  );
  const topupUnique = await record(
    "idx_wallet_topups_sale_order_id",
    async () =>
      (await hasIndex(strapi, "idx_wallet_topups_sale_order_id")) &&
      (await hasIndex(strapi, "idx_wallet_topups_idempotency_key")),
    "top-up uniqueness missing",
  );

  const holds =
    heldBalance && holdColumns && oneWalletPerUser && noDuplicateWallets && ledgerUnique;
  const topups =
    oneWalletPerUser &&
    noDuplicateWallets &&
    ledgerUnique &&
    topupTable &&
    topupColumns &&
    topupOwnership &&
    validTopupOwners &&
    topupUnique;

  cached = { evaluatedAt: new Date().toISOString(), holds, topups, checks };

  if (!holds || !topups) {
    const failed = checks.filter((check) => !check.ok).map((check) => check.key).join(", ");
    strapi.log.error(
      `Wallet readiness incomplete (holds=${holds} topups=${topups}); unmet prerequisites: ${failed}. The affected wallet capabilities stay disabled until they are repaired.`,
    );
  }
  return cached;
}

export const getWalletReadiness = (): WalletReadiness => cached;

/** Test seam: integration tests re-evaluate readiness against their own database. */
export const __setWalletReadinessForTests = (value: WalletReadiness) => {
  cached = value;
};

/**
 * Master gate for *creating* wallet holds — including wallet-only payments, so
 * that "flags off" genuinely means "no hold rows exist". Capture, release,
 * reconciliation and refunds never consult it: work already in flight must
 * always be completable.
 */
export const isWalletHoldsEnabled = (): boolean =>
  truthy(process.env.WALLET_HOLDS_ENABLED) && cached.holds;

/** Partial wallet tender at checkout. Requires holds. */
export const isWalletSplitEnabled = (): boolean =>
  isWalletHoldsEnabled() && truthy(process.env.WALLET_CHECKOUT_SPLIT_ENABLED);

/** Partial wallet tender combined with SnappPay BNPL. Requires split. */
export const isWalletSnappaySplitEnabled = (): boolean =>
  isWalletSplitEnabled() && truthy(process.env.WALLET_SPLIT_SNAPPAY_ENABLED);

/** Creating new top-up intents. Callbacks and reconciliation ignore this. */
export const isWalletTopupEnabled = (): boolean =>
  truthy(process.env.WALLET_TOPUP_ENABLED) && cached.topups;
