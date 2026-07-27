import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { claimSnappayOperation } from "../../../api/payment-gateway/services/snappay-orchestrator";

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
             'callback_nonce_ciphertext',
             'side_effects_completed_at'
           ))
           OR
           (table_name = 'contract_transactions' AND column_name IN (
             'payment_token_ciphertext',
             'payment_token_hash',
             'payment_token_key_version',
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
        "payment_attempts.callback_nonce_ciphertext",
        "payment_attempts.side_effects_completed_at",
        "contract_transactions.payment_token_ciphertext",
        "contract_transactions.payment_token_hash",
        "contract_transactions.payment_token_key_version",
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
    expect(attemptModel.attributes.callbackNonceCiphertext.private).toBe(true);
    expect(transactionModel.attributes.PaymentTokenCiphertext.private).toBe(true);
    expect(transactionModel.attributes.PaymentTokenHash.private).toBe(true);
    expect(operationModel.attributes.attemptKey.private).toBe(true);
  });

  it("reasserts partial uniqueness and recovery indexes after schema sync", async () => {
    const result = await strapi.db.connection.raw(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'idx_payment_attempts_snappay_transaction',
           'idx_payment_attempts_snappay_due',
           'idx_payment_attempts_attempt_id',
           'idx_contract_transactions_snappay_transaction',
           'idx_contract_transactions_snappay_token_hash',
           'idx_payment_operations_due',
           'idx_payment_operations_idempotency_key'
         )`,
    );

    expect(result.rows.map((row: any) => row.indexname).sort()).toEqual([
      "idx_contract_transactions_snappay_token_hash",
      "idx_contract_transactions_snappay_transaction",
      "idx_payment_attempts_attempt_id",
      "idx_payment_attempts_snappay_due",
      "idx_payment_attempts_snappay_transaction",
      "idx_payment_operations_due",
      "idx_payment_operations_idempotency_key",
    ]);
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
});
