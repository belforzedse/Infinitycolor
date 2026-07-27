/**
 * Adds durable SnappPay state, encrypted-token storage, recovery operations,
 * and uniqueness guarantees for hardened (non-legacy) records.
 */
const { createCipheriv, createHmac, randomBytes } = require("node:crypto");

function encryptionMaterial() {
  const encoded = String(process.env.PAYMENT_TOKEN_ENCRYPTION_KEY || "").trim();
  const version = String(process.env.PAYMENT_TOKEN_ENCRYPTION_KEY_VERSION || "").trim();
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || !/^[A-Za-z0-9._-]{1,32}$/.test(version)) {
    throw new Error(
      "Legacy SnappPay tokens exist; configure a valid PAYMENT_TOKEN_ENCRYPTION_KEY and PAYMENT_TOKEN_ENCRYPTION_KEY_VERSION before migrating",
    );
  }
  return { key, version };
}

function encryptToken(token, material) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", material.key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    material.version,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function tokenHash(token, material) {
  return createHmac("sha256", material.key).update(String(token)).digest("hex");
}

module.exports = {
  async up(knex) {
    const hasColumn = (table, column) => knex.schema.hasColumn(table, column);
    const hasPaymentAttempts = await knex.schema.hasTable("payment_attempts");
    const hasContractTransactions = await knex.schema.hasTable("contract_transactions");

    if (hasPaymentAttempts) {
      const columns = {
        providerStatus: await hasColumn("payment_attempts", "provider_status"),
        nextAction: await hasColumn("payment_attempts", "next_action"),
        nextActionAt: await hasColumn("payment_attempts", "next_action_at"),
        leaseUntil: await hasColumn("payment_attempts", "lease_until"),
        leaseVersion: await hasColumn("payment_attempts", "lease_version"),
        callbackNonceHash: await hasColumn("payment_attempts", "callback_nonce_hash"),
        callbackNonceCiphertext: await hasColumn("payment_attempts", "callback_nonce_ciphertext"),
        sideEffectsCompletedAt: await hasColumn("payment_attempts", "side_effects_completed_at"),
      };
      await knex.schema.alterTable("payment_attempts", (table) => {
        if (!columns.providerStatus) table.string("provider_status").nullable();
        if (!columns.nextAction) table.string("next_action").nullable();
        if (!columns.nextActionAt) {
          table.timestamp("next_action_at", { useTz: true }).nullable();
        }
        if (!columns.leaseUntil) {
          table.timestamp("lease_until", { useTz: true }).nullable();
        }
        if (!columns.leaseVersion) {
          table.integer("lease_version").notNullable().defaultTo(0);
        }
        if (!columns.callbackNonceHash) {
          table.string("callback_nonce_hash", 64).nullable();
        }
        if (!columns.callbackNonceCiphertext) {
          table.text("callback_nonce_ciphertext").nullable();
        }
        if (!columns.sideEffectsCompletedAt) {
          table.timestamp("side_effects_completed_at", { useTz: true }).nullable();
        }
      });
    }

    if (hasContractTransactions) {
      const names = [
        "payment_token_ciphertext",
        "payment_token_hash",
        "payment_token_key_version",
        "settled_at",
        "reverted_at",
        "cancelled_at",
        "last_reconciled_at",
        "last_http_status",
        "last_provider_code",
      ];
      const present = {};
      for (const name of names) {
        present[name] = await hasColumn("contract_transactions", name);
      }
      await knex.schema.alterTable("contract_transactions", (table) => {
        if (!present.payment_token_ciphertext) {
          table.text("payment_token_ciphertext").nullable();
        }
        if (!present.payment_token_hash) {
          table.string("payment_token_hash", 64).nullable();
        }
        if (!present.payment_token_key_version) {
          table.string("payment_token_key_version", 32).nullable();
        }
        if (!present.settled_at) {
          table.timestamp("settled_at", { useTz: true }).nullable();
        }
        if (!present.reverted_at) {
          table.timestamp("reverted_at", { useTz: true }).nullable();
        }
        if (!present.cancelled_at) {
          table.timestamp("cancelled_at", { useTz: true }).nullable();
        }
        if (!present.last_reconciled_at) {
          table.timestamp("last_reconciled_at", { useTz: true }).nullable();
        }
        if (!present.last_http_status) table.integer("last_http_status").nullable();
        if (!present.last_provider_code) {
          table.integer("last_provider_code").nullable();
        }
      });
    }

    const hasPaymentOperations = await knex.schema.hasTable("payment_operations");
    if (!hasPaymentOperations) {
      await knex.schema.createTable("payment_operations", (table) => {
        table.increments("id").primary();
        table.string("idempotency_key", 255).notNullable().unique();
        table.string("operation_type", 32).notNullable();
        table.string("status", 32).notNullable().defaultTo("Queued");
        table.string("provider_status", 64).nullable();
        table.integer("http_status").nullable();
        table.integer("provider_code").nullable();
        table.integer("retry_count").notNullable().defaultTo(0);
        table.timestamp("next_run_at", { useTz: true }).nullable();
        table.timestamp("lease_until", { useTz: true }).nullable();
        table.text("failure_message").nullable();
        table.jsonb("metadata").nullable();
        table.integer("attempt_key").nullable();
        table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
    } else if (!(await hasColumn("payment_operations", "attempt_key"))) {
      await knex.schema.alterTable("payment_operations", (table) => {
        table.integer("attempt_key").nullable();
      });
    }

    if (hasContractTransactions) {
      const legacyTokens = await knex("contract_transactions")
        .select(["id", "track_id"])
        .whereRaw("lower(external_source) = 'snappay'")
        .whereNotNull("track_id");
      if (legacyTokens.length > 0) {
        const material = encryptionMaterial();
        await knex.transaction(async (trx) => {
          for (const row of legacyTokens) {
            await trx("contract_transactions")
              .where({ id: row.id })
              .update({
                payment_token_ciphertext: encryptToken(row.track_id, material),
                payment_token_hash: tokenHash(row.track_id, material),
                payment_token_key_version: material.version,
                track_id: null,
              });
          }
        });
      }
    }

    if (await knex.schema.hasTable("order_logs")) {
      const hasChanges = await hasColumn("order_logs", "changes");
      if (hasChanges) {
        const [{ data_type: changesType } = {}] = await knex("information_schema.columns")
          .select("data_type")
          .where({
            table_schema: "public",
            table_name: "order_logs",
            column_name: "changes",
          })
          .limit(1);
        if (changesType === "json" || changesType === "jsonb") {
          await knex.raw(
            `UPDATE order_logs
             SET changes = (
               changes::jsonb
                 #- '{snappay,token}'
                 #- '{snappay,payload,paymentToken}'
             )::${changesType}
             WHERE changes IS NOT NULL
               AND changes::text ILIKE '%paymentToken%'`,
          );
        }
      }
    }
    if (hasContractTransactions && (await hasColumn("contract_transactions", "gateway_response"))) {
      const [{ data_type: responseType } = {}] = await knex("information_schema.columns")
        .select("data_type")
        .where({
          table_schema: "public",
          table_name: "contract_transactions",
          column_name: "gateway_response",
        })
        .limit(1);
      if (responseType === "json" || responseType === "jsonb") {
        await knex.raw(
          `UPDATE contract_transactions
           SET gateway_response = (
             gateway_response::jsonb
               #- '{paymentToken}'
               #- '{response,paymentToken}'
               #- '{access_token}'
           )::${responseType}
           WHERE lower(external_source) = 'snappay'
             AND gateway_response IS NOT NULL`,
        );
      }
    }

    if (hasPaymentAttempts) {
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_attempt_id
         ON payment_attempts (attempt_id)
         WHERE attempt_id IS NOT NULL`,
      );
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_snappay_transaction
         ON payment_attempts (provider_reference)
         WHERE lower(gateway) = 'snappay' AND provider_reference IS NOT NULL`,
      );
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_payment_attempts_snappay_due
         ON payment_attempts (next_action_at)
         WHERE lower(gateway) = 'snappay'
           AND status IN ('Pending', 'Redirected', 'Unknown')`,
      );
    }
    if (hasContractTransactions) {
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_transactions_snappay_transaction
         ON contract_transactions (external_id)
         WHERE lower(external_source) = 'snappay'
           AND external_id IS NOT NULL
           AND gateway_status IS NOT NULL`,
      );
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_transactions_snappay_token_hash
         ON contract_transactions (payment_token_hash)
         WHERE payment_token_hash IS NOT NULL`,
      );
    }
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_payment_operations_due
       ON payment_operations (status, next_run_at, lease_until)
       WHERE status IN ('Queued', 'Processing', 'Unknown')`,
    );
  },

  async down(knex) {
    await knex.raw("DROP INDEX IF EXISTS idx_payment_operations_idempotency_key");
    await knex.raw("DROP INDEX IF EXISTS idx_payment_operations_due");
    await knex.raw("DROP INDEX IF EXISTS idx_payment_attempts_attempt_id");
    await knex.raw("DROP INDEX IF EXISTS idx_payment_attempts_snappay_due");
    await knex.raw("DROP INDEX IF EXISTS idx_contract_transactions_snappay_token_hash");
    await knex.raw("DROP INDEX IF EXISTS idx_contract_transactions_snappay_transaction");
    await knex.raw("DROP INDEX IF EXISTS idx_payment_attempts_snappay_transaction");
    if (await knex.schema.hasTable("payment_operations")) {
      await knex.schema.dropTable("payment_operations");
    }
  },
};
