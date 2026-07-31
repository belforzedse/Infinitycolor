import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { claimSnappayOperation } from "../../../api/payment-gateway/services/snappay-orchestrator";

const hardeningMigration = require(
  "../../../../database/migrations/2026.07.27T12.00.00.harden-snappay-payments.js",
);
const conflictingIndexRepair = require(
  "../../../../database/migrations/2026.07.28T12.00.00.drop-strapi-conflicting-snappay-indexes.js",
);

let strapi: any;
const operationIds: number[] = [];

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterEach(async () => {
  for (const id of operationIds.splice(0).reverse()) {
    await strapi.db
      .query("api::payment-operation.payment-operation")
      .delete({ where: { id } })
      .catch(() => undefined);
  }
});

afterAll(async () => {
  await teardownStrapi();
});

describe("SnappPay hardened persistence", () => {
  it("boots with every private recovery column on real Postgres", async () => {
    const result = await strapi.db.connection.raw(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'payment_attempts' AND column_name IN (
             'provider_status',
             'next_action',
             'next_action_at',
             'lease_until',
             'lease_version',
             'callback_nonce_hash',
             'callback_nonce',
             'side_effects_completed_at'
           ))
           OR
           (table_name = 'contract_transactions' AND column_name IN (
             'settled_at',
             'reverted_at',
             'cancelled_at',
             'last_reconciled_at',
             'last_http_status',
             'last_provider_code'
           ))
           OR
           (table_name = 'payment_operations' AND column_name = 'attempt_key')
         )`,
    );
    const columns = new Set(result.rows.map((row: any) => `${row.table_name}.${row.column_name}`));

    expect(columns).toEqual(
      new Set([
        "payment_attempts.provider_status",
        "payment_attempts.next_action",
        "payment_attempts.next_action_at",
        "payment_attempts.lease_until",
        "payment_attempts.lease_version",
        "payment_attempts.callback_nonce_hash",
        "payment_attempts.callback_nonce",
        "payment_attempts.side_effects_completed_at",
        "contract_transactions.settled_at",
        "contract_transactions.reverted_at",
        "contract_transactions.cancelled_at",
        "contract_transactions.last_reconciled_at",
        "contract_transactions.last_http_status",
        "contract_transactions.last_provider_code",
        "payment_operations.attempt_key",
      ]),
    );

    const attemptModel = strapi.getModel("api::payment-attempt.payment-attempt");
    const transactionModel = strapi.getModel("api::contract-transaction.contract-transaction");
    const operationModel = strapi.getModel("api::payment-operation.payment-operation");
    expect(attemptModel.attributes.callbackNonceHash.private).toBe(true);
    expect(attemptModel.attributes.callbackNonce.private).toBe(true);
    // The SnappPay payment token now lives in TrackId in the clear: it is not
    // usable without our OAuth credentials, and operators need it verbatim for
    // provider support tickets. The encryption columns are gone.
    expect(transactionModel.attributes.PaymentTokenCiphertext).toBeUndefined();
    expect(transactionModel.attributes.PaymentTokenHash).toBeUndefined();
    expect(operationModel.attributes.attemptKey.private).toBe(true);
  });

  it("keeps compatible constraints, expression guards, and recovery indexes", async () => {
    const result = await strapi.db.connection.raw(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'idx_payment_attempts_snappay_transaction',
           'idx_payment_attempts_snappay_due',
           'idx_payment_attempts_attempt_id',
           'idx_contract_transactions_snappay_transaction',
           'idx_payment_operations_due',
           'idx_payment_operations_idempotency_key'
         )`,
    );

    expect(result.rows.map((row: any) => row.indexname).sort()).toEqual([
      "idx_contract_transactions_snappay_transaction",
      "idx_payment_attempts_snappay_due",
      "idx_payment_attempts_snappay_transaction",
      "idx_payment_operations_due",
    ]);
    for (const row of result.rows) {
      if (row.indexname.includes("snappay_transaction")) {
        expect(row.indexdef).toContain("CASE");
      }
    }

    const uniqueResult = await strapi.db.connection.raw(
      `SELECT tablename, indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'payment_attempts_attempt_id_unique',
           'payment_operations_idempotency_key_unique'
         )
       ORDER BY tablename, indexname`,
    );
    expect(uniqueResult.rows).toEqual([
      {
        tablename: "payment_attempts",
        indexname: "payment_attempts_attempt_id_unique",
      },
      {
        tablename: "payment_operations",
        indexname: "payment_operations_idempotency_key_unique",
      },
    ]);
  });

  it("does not add unmanaged unique indexes when legacy identifiers are duplicated", async () => {
    const schemaName = `snappay_migration_duplicate_${Date.now()}`;
    const connection = strapi.db.connection;

    await connection.raw(`CREATE SCHEMA "${schemaName}"`);
    try {
      await connection.transaction(async (trx: any) => {
        await trx.raw(`SET LOCAL search_path TO "${schemaName}"`);
        await trx.raw(
          `CREATE TABLE payment_attempts (
             attempt_id text,
             provider_reference text,
             gateway text,
             status text
           )`,
        );
        await trx.raw(
          `CREATE TABLE contract_transactions (
             external_source text,
             external_id text,
             gateway_status text
           )`,
        );
        await trx.raw(
          `INSERT INTO payment_attempts
             (attempt_id, provider_reference, gateway, status)
           VALUES
             ('duplicate-attempt', 'duplicate-provider', 'SnappPay', 'Pending'),
             ('duplicate-attempt', 'duplicate-provider', 'snappay', 'Pending')`,
        );
        await trx.raw(
          `INSERT INTO contract_transactions
             (external_source, external_id, gateway_status)
           VALUES
             ('SnappPay', 'duplicate-transaction', 'Pending'),
             ('snappay', 'duplicate-transaction', 'Pending')`,
        );

        await expect(hardeningMigration.up(trx)).resolves.toBeUndefined();

        const result = await trx.raw(
          `SELECT indexname
           FROM pg_indexes
           WHERE schemaname = ?`,
          [schemaName],
        );
        const indexes = new Set(result.rows.map((row: any) => row.indexname));
        expect(indexes).not.toContain("idx_payment_attempts_attempt_id");
        expect(indexes).not.toContain("idx_payment_attempts_snappay_transaction");
        expect(indexes).not.toContain("idx_contract_transactions_snappay_transaction");
        expect(indexes).toContain("idx_payment_attempts_snappay_due");
        expect(indexes).toContain("idx_payment_operations_due");
      });
    } finally {
      await connection.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  });

  it("repairs persisted partial unique indexes before schema synchronization", async () => {
    const schemaName = `snappay_index_repair_${Date.now()}`;
    const connection = strapi.db.connection;

    await connection.raw(`CREATE SCHEMA "${schemaName}"`);
    try {
      await connection.transaction(async (trx: any) => {
        await trx.raw(`SET LOCAL search_path TO "${schemaName}"`);
        await trx.raw(
          `CREATE TABLE payment_attempts (
             attempt_id text,
             provider_reference text,
             gateway text
           )`,
        );
        await trx.raw(
          `CREATE TABLE contract_transactions (
             external_source text,
             external_id text,
             gateway_status text
           )`,
        );
        await trx.raw(
          `CREATE TABLE payment_operations (
             idempotency_key text
           )`,
        );
        await trx.raw(
          `CREATE UNIQUE INDEX idx_payment_attempts_attempt_id
           ON payment_attempts (attempt_id)
           WHERE attempt_id IS NOT NULL`,
        );
        await trx.raw(
          `CREATE UNIQUE INDEX idx_payment_attempts_snappay_transaction
           ON payment_attempts (provider_reference)
           WHERE lower(gateway) IN ('snappay', 'snapppay')
             AND provider_reference IS NOT NULL`,
        );
        await trx.raw(
          `CREATE UNIQUE INDEX idx_contract_transactions_snappay_transaction
           ON contract_transactions (external_id)
           WHERE lower(external_source) IN ('snappay', 'snapppay')
             AND external_id IS NOT NULL
             AND gateway_status IS NOT NULL`,
        );
        await trx.raw(
          `CREATE UNIQUE INDEX idx_payment_operations_idempotency_key
           ON payment_operations (idempotency_key)
           WHERE idempotency_key IS NOT NULL`,
        );

        await expect(conflictingIndexRepair.up(trx)).resolves.toBeUndefined();

        const result = await trx.raw(
          `SELECT indexname
           FROM pg_indexes
           WHERE schemaname = ?
             AND indexname IN (
               'idx_payment_attempts_attempt_id',
               'idx_payment_attempts_snappay_transaction',
               'idx_contract_transactions_snappay_transaction',
               'idx_payment_operations_idempotency_key'
             )`,
          [schemaName],
        );
        expect(result.rows).toEqual([]);
      });
    } finally {
      await connection.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  });

  it("persists operations durably and enforces idempotency keys", async () => {
    const query = strapi.db.query("api::payment-operation.payment-operation");
    const idempotencyKey = `JEST_TEST__snappay-operation-${Date.now()}`;
    const created = await query.create({
      data: {
        idempotencyKey,
        OperationType: "RECONCILE",
        Status: "Queued",
        retryCount: 0,
        metadata: { reason: "integration-proof" },
        attemptKey: null,
      },
    });
    operationIds.push(created.id);

    await expect(
      query.create({
        data: {
          idempotencyKey,
          OperationType: "RECONCILE",
          Status: "Queued",
          retryCount: 0,
        },
      }),
    ).rejects.toBeDefined();

    const persisted = await query.findOne({
      where: { id: created.id },
    });
    expect(persisted).toEqual(
      expect.objectContaining({
        idempotencyKey,
        OperationType: "RECONCILE",
        Status: "Queued",
      }),
    );
  });

  it("never reclaims terminal manual-review operations from stale queue jobs", async () => {
    const query = strapi.db.query("api::payment-operation.payment-operation");
    const dueAt = new Date(Date.now() - 60_000);
    const terminal = await query.create({
      data: {
        idempotencyKey: `JEST_TEST__terminal-operation-${Date.now()}`,
        OperationType: "RECONCILE",
        Status: "Unknown",
        retryCount: 5,
        nextRunAt: null,
      },
    });
    const recoverable = await query.create({
      data: {
        idempotencyKey: `JEST_TEST__recoverable-operation-${Date.now()}`,
        OperationType: "RECONCILE",
        Status: "Unknown",
        retryCount: 1,
        nextRunAt: dueAt,
      },
    });
    operationIds.push(terminal.id, recoverable.id);

    await expect(claimSnappayOperation(strapi, terminal.id)).resolves.toBe(false);
    await expect(claimSnappayOperation(strapi, recoverable.id)).resolves.toBe(true);

    const [terminalAfter, recoverableAfter] = await Promise.all([
      query.findOne({ where: { id: terminal.id } }),
      query.findOne({ where: { id: recoverable.id } }),
    ]);
    expect(terminalAfter).toEqual(expect.objectContaining({ Status: "Unknown", nextRunAt: null }));
    expect(recoverableAfter).toEqual(expect.objectContaining({ Status: "Processing" }));
    expect(recoverableAfter.leaseUntil).toBeTruthy();
  });

  it("boots again after the real uniqueness constraints have persisted", async () => {
    await teardownStrapi();
    strapi = await setupStrapi();

    const result = await strapi.db.connection.raw(
      `SELECT conname
       FROM pg_constraint
       WHERE conname IN (
         'payment_attempts_attempt_id_unique',
         'payment_operations_idempotency_key_unique'
       )
       ORDER BY conname`,
    );
    expect(result.rows.map((row: any) => row.conname)).toEqual([
      "payment_attempts_attempt_id_unique",
      "payment_operations_idempotency_key_unique",
    ]);
  });
});
