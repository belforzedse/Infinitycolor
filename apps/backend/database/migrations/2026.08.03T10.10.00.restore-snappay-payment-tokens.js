'use strict';

/**
 * Restores SnappPay payment tokens that settlement finalization accidentally
 * cleared. The trusted payment redirect URL retained the same token, together
 * with a non-reversible fingerprint recorded at initiation.
 *
 * Previously failed operator actions are marked Failed (never re-queued) so an
 * administrator may make a fresh decision after checking fulfillment state.
 */

const { createHash } = require('node:crypto');

const SNAPPAY_MIGRATION_LOCK_KEY = 827453100;

function parseJson(value) {
  if (!value || typeof value === 'object') return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function recoverToken(row) {
  let url;
  try {
    url = new URL(String(row.redirect_url || ''));
  } catch {
    return '';
  }
  if (url.protocol !== 'https:') return '';
  const token = String(url.searchParams.get('paymentToken') || '').trim();
  if (!token || token.length > 255 || /\s/.test(token)) return '';

  const expectedFingerprint = String(
    parseJson(row.provider_response).tokenFingerprint || '',
  ).trim();
  const actualFingerprint = createHash('sha256')
    .update(token)
    .digest('hex')
    .slice(0, 12);
  if (expectedFingerprint && expectedFingerprint !== actualFingerprint) return '';
  return token;
}

module.exports = {
  async up(knex) {
    await knex.raw('SELECT pg_advisory_xact_lock(?)', [
      SNAPPAY_MIGRATION_LOCK_KEY,
    ]);

    const requiredTables = [
      'payment_attempts',
      'payment_attempts_contract_links',
      'contract_transactions_contract_links',
      'contract_transactions',
    ];
    for (const table of requiredTables) {
      if (!(await knex.schema.hasTable(table))) return;
    }

    const candidates = await knex('payment_attempts as attempt')
      .join(
        'payment_attempts_contract_links as attempt_contract',
        'attempt_contract.payment_attempt_id',
        'attempt.id',
      )
      .join(
        'contract_transactions_contract_links as transaction_contract',
        'transaction_contract.contract_id',
        'attempt_contract.contract_id',
      )
      .join(
        'contract_transactions as transaction',
        'transaction.id',
        'transaction_contract.contract_transaction_id',
      )
      .select(
        'attempt.id as attempt_id',
        'attempt.redirect_url',
        'attempt.provider_response',
        'transaction.id as transaction_id',
      )
      .whereRaw("lower(attempt.gateway) in ('snappay', 'snapppay')")
      .where('attempt.status', 'Succeeded')
      .whereRaw("lower(transaction.external_source) in ('snappay', 'snapppay')")
      .whereRaw('transaction.external_id = attempt.provider_reference')
      .where((builder) =>
        builder
          .whereNull('transaction.track_id')
          .orWhere('transaction.track_id', ''),
      );

    const restoredAttemptIds = [];
    for (const row of candidates) {
      const token = recoverToken(row);
      if (!token) continue;
      await knex('contract_transactions')
        .where({ id: row.transaction_id })
        .where((builder) =>
          builder.whereNull('track_id').orWhere('track_id', ''),
        )
        .update({ track_id: token, updated_at: knex.fn.now() });
      restoredAttemptIds.push(row.attempt_id);
    }

    let releasedOperations = 0;
    if (
      restoredAttemptIds.length > 0 &&
      (await knex.schema.hasTable('payment_operations')) &&
      (await knex.schema.hasColumn('payment_operations', 'attempt_key'))
    ) {
      releasedOperations = await knex('payment_operations')
        .whereIn('attempt_key', restoredAttemptIds)
        .whereIn('operation_type', ['CANCEL', 'UPDATE'])
        .where('status', 'Unknown')
        .where(
          'failure_message',
          'like',
          'SNAPPAY_PAYMENT_TOKEN_MISSING:%',
        )
        .update({
          status: 'Failed',
          next_run_at: null,
          lease_until: null,
          failure_message:
            'SNAPPAY_PAYMENT_TOKEN_RESTORED:Provider token restored; submit a new operator request after checking order state',
          updated_at: knex.fn.now(),
        });
    }

    console.info(
      `SnappPay token recovery complete: transactions=${restoredAttemptIds.length} releasedOperations=${releasedOperations}`,
    );
  },

  async down() {
    // Intentionally irreversible: restored provider tokens are required for
    // subsequent update/cancel operations and must not be deleted again.
  },
};
