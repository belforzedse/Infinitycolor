"use strict";

const crypto = require("node:crypto");

const sha256Pattern = /^[a-f0-9]{64}$/i;

class SyncStateStore {
  constructor(pool, { owner, leaseSeconds = 300 } = {}) {
    this.pool = pool;
    this.owner = String(owner || "");
    this.leaseSeconds = leaseSeconds;
    if (!this.owner) throw new Error("SyncStateStore requires an owner");
  }

  async control() {
    const result = await this.pool.query("SELECT * FROM woocommerce_sync_control WHERE id = 1");
    if (result.rowCount !== 1) throw new Error("WOOCOMMERCE_SYNC_CONTROL_MISSING");
    return result.rows[0];
  }

  async setMode(mode, { reconciliationRunId = null, reconciliationSha256 = null } = {}) {
    if (!new Set(["disabled", "shadow", "active"]).has(mode)) throw new Error("WOOCOMMERCE_SYNC_MODE_INVALID");
    if (mode === "active") {
      if (!String(reconciliationRunId || "").trim() || !sha256Pattern.test(String(reconciliationSha256 || ""))) {
        throw new Error("Active mode requires a reconciliation run id and SHA-256");
      }
    }
    const result = await this.pool.query(
      `UPDATE woocommerce_sync_control
          SET mode = $1::varchar,
              activated_at = CASE WHEN $1::varchar = 'active' THEN COALESCE(activated_at, now()) ELSE activated_at END,
              reconciliation_run_id = CASE WHEN $1::varchar = 'active' THEN $2::varchar ELSE reconciliation_run_id END,
              reconciliation_sha256 = CASE WHEN $1::varchar = 'active' THEN $3::varchar ELSE reconciliation_sha256 END,
              updated_at = now()
        WHERE id = 1
      RETURNING *`,
      [mode, reconciliationRunId, reconciliationSha256],
    );
    return result.rows[0];
  }

  async baselineStatus() {
    const cursors = await this.pool.query(
      `SELECT source_type, updated_at
         FROM woocommerce_sync_cursors
        WHERE source_type = ANY($1::text[])`,
      [["product", "order"]],
    );
    const counts = await this.pool.query(
      `SELECT source_type, COUNT(*)::bigint AS count
         FROM woocommerce_sync_items
        WHERE source_type = ANY($1::text[])
        GROUP BY source_type`,
      [["product", "order"]],
    );
    const cursorTypes = new Set(cursors.rows.map((row) => row.source_type));
    const countByType = new Map(counts.rows.map((row) => [row.source_type, Number(row.count)]));
    return {
      ready: cursorTypes.has("product") && cursorTypes.has("order") &&
        Number(countByType.get("product") || 0) > 0 && Number(countByType.get("order") || 0) > 0,
      cursors: cursors.rows,
      counts: Object.fromEntries(countByType),
    };
  }

  async acquireLease(name) {
    const token = crypto.randomBytes(24).toString("hex");
    const result = await this.pool.query(
      `INSERT INTO woocommerce_sync_leases (name, owner, fencing_token, lease_until, updated_at)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 second'), now())
       ON CONFLICT (name) DO UPDATE
         SET owner = EXCLUDED.owner,
             fencing_token = EXCLUDED.fencing_token,
             lease_until = EXCLUDED.lease_until,
             updated_at = now()
       WHERE woocommerce_sync_leases.lease_until < now()
          OR woocommerce_sync_leases.owner = EXCLUDED.owner
       RETURNING fencing_token, lease_until`,
      [name, this.owner, token, this.leaseSeconds],
    );
    return result.rowCount === 1 ? { token: result.rows[0].fencing_token, leaseUntil: result.rows[0].lease_until } : null;
  }

  async assertLease(name, token) {
    const result = await this.pool.query(
      `UPDATE woocommerce_sync_leases
          SET lease_until = now() + ($4 * interval '1 second'), updated_at = now()
        WHERE name = $1 AND owner = $2 AND fencing_token = $3 AND lease_until > now()
      RETURNING fencing_token`,
      [name, this.owner, token, this.leaseSeconds],
    );
    if (result.rowCount !== 1) {
      const error = new Error(`Woo sync lease ${name} is no longer owned`);
      error.code = "WOOCOMMERCE_SYNC_FENCE_REJECTED";
      throw error;
    }
  }

  async releaseLease(name, token) {
    await this.pool.query(
      `DELETE FROM woocommerce_sync_leases WHERE name = $1 AND owner = $2 AND fencing_token = $3`,
      [name, this.owner, token],
    );
  }

  async cursor(sourceType) {
    const result = await this.pool.query(
      "SELECT cursor_time, cursor_id, sweep_page FROM woocommerce_sync_cursors WHERE source_type = $1",
      [sourceType],
    );
    return result.rows[0] || { cursor_time: null, cursor_id: "0", sweep_page: 1 };
  }

  async saveCursor(sourceType, { cursorTime = null, cursorId = 0, sweepPage = 1 }, leaseName, token) {
    await this.assertLease(leaseName, token);
    await this.pool.query(
      `INSERT INTO woocommerce_sync_cursors (source_type, cursor_time, cursor_id, sweep_page, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (source_type) DO UPDATE
         SET cursor_time = EXCLUDED.cursor_time,
             cursor_id = EXCLUDED.cursor_id,
             sweep_page = EXCLUDED.sweep_page,
             updated_at = now()`,
      [sourceType, cursorTime, cursorId, sweepPage],
    );
  }

  async observe(
    { sourceType, sourceId, parentSourceId = null, revisionSha256, modifiedAt = null },
    mode,
    { initialObserved = false, insertLane = "immediate" } = {},
  ) {
    if (!sha256Pattern.test(String(revisionSha256))) throw new Error("WOOCOMMERCE_SYNC_REVISION_INVALID");
    const active = mode === "active";
    const queueOnInsert = active && !initialObserved;
    const result = await this.pool.query(
      `INSERT INTO woocommerce_sync_items
         (source_type, source_id, parent_source_id, source_revision_sha256, source_modified_at,
          lane, status, next_attempt_at, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), now())
       ON CONFLICT (source_type, source_id) DO UPDATE
         SET parent_source_id = EXCLUDED.parent_source_id,
             source_modified_at = EXCLUDED.source_modified_at,
             last_seen_at = now(),
             lane = CASE
               WHEN woocommerce_sync_items.source_revision_sha256 <> EXCLUDED.source_revision_sha256 AND $8
                 THEN 'hourly'
               ELSE woocommerce_sync_items.lane
             END,
             status = CASE
               WHEN woocommerce_sync_items.source_revision_sha256 <> EXCLUDED.source_revision_sha256 AND $8
                    AND woocommerce_sync_items.status <> 'running' THEN 'pending'
               WHEN NOT $8 THEN 'observed'
               ELSE woocommerce_sync_items.status
             END,
             next_attempt_at = CASE
               WHEN woocommerce_sync_items.source_revision_sha256 <> EXCLUDED.source_revision_sha256 AND $8
                 THEN now()
               ELSE woocommerce_sync_items.next_attempt_at
             END,
             source_revision_sha256 = EXCLUDED.source_revision_sha256
       RETURNING id, source_type, source_id, lane, status, (xmax = 0) AS inserted`,
      [
        sourceType,
        sourceId,
        parentSourceId,
        revisionSha256,
        modifiedAt,
        queueOnInsert ? insertLane : "hourly",
        queueOnInsert ? "pending" : "observed",
        active,
      ],
    );
    return result.rows[0];
  }

  async claimItems({ lane, sourceTypes, limit, token }) {
    const result = await this.pool.query(
      `WITH due AS (
         SELECT id
           FROM woocommerce_sync_items
          WHERE (status IN ('pending', 'failed') OR (status = 'running' AND claim_until < now()))
            AND lane = $1
            AND source_type = ANY($2::text[])
            AND next_attempt_at <= now()
            AND (claim_until IS NULL OR claim_until < now())
          ORDER BY next_attempt_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $3
       )
       UPDATE woocommerce_sync_items AS item
          SET status = 'running',
              attempts = attempts + 1,
              claim_fencing_token = $4,
              claimed_revision_sha256 = source_revision_sha256,
              claim_until = now() + ($5 * interval '1 second')
         FROM due
        WHERE item.id = due.id
      RETURNING item.*`,
      [lane, sourceTypes, limit, token, this.leaseSeconds],
    );
    return result.rows;
  }

  async completeItem(id, token) {
    const result = await this.pool.query(
      `UPDATE woocommerce_sync_items
          SET status = CASE
                WHEN source_revision_sha256 <> claimed_revision_sha256 THEN 'pending'
                ELSE 'completed'
              END,
              lane = CASE
                WHEN source_revision_sha256 <> claimed_revision_sha256 THEN 'hourly'
                ELSE lane
              END,
              completed_at = now(), claim_fencing_token = NULL,
              claimed_revision_sha256 = NULL, claim_until = NULL, last_error_code = NULL
        WHERE id = $1 AND claim_fencing_token = $2
      RETURNING id, status`,
      [id, token],
    );
    if (result.rowCount !== 1) throw Object.assign(new Error("Woo sync item fence rejected"), { code: "WOOCOMMERCE_SYNC_FENCE_REJECTED" });
  }

  async failItem(id, token, errorCode) {
    const result = await this.pool.query(
      `UPDATE woocommerce_sync_items
          SET status = CASE WHEN attempts >= 8 THEN 'quarantined' ELSE 'failed' END,
              next_attempt_at = now() + (LEAST(3600, 30 * power(2, LEAST(attempts, 7))) * interval '1 second'),
              claim_fencing_token = NULL, claimed_revision_sha256 = NULL,
              claim_until = NULL, last_error_code = $3
        WHERE id = $1 AND claim_fencing_token = $2
      RETURNING id, status`,
      [id, token, String(errorCode || "UNKNOWN").slice(0, 128)],
    );
    if (result.rowCount !== 1) throw Object.assign(new Error("Woo sync item fence rejected"), { code: "WOOCOMMERCE_SYNC_FENCE_REJECTED" });
    return result.rows[0];
  }

  /**
   * Durable campaign/reconcile outcome for an order without hourly claim fencing.
   * Idempotent on (source_type, source_id).
   */
  async recordOrderOutcome({
    sourceId,
    revisionSha256,
    modifiedAt = null,
    outcome,
    errorCode = null,
    lane = "campaign",
  }) {
    if (!sha256Pattern.test(String(revisionSha256))) throw new Error("WOOCOMMERCE_SYNC_REVISION_INVALID");
    if (!["completed", "failed", "quarantined"].includes(outcome)) {
      throw new Error("WOOCOMMERCE_SYNC_OUTCOME_INVALID");
    }
    const result = await this.pool.query(
      `INSERT INTO woocommerce_sync_items
         (source_type, source_id, source_revision_sha256, source_modified_at,
          lane, status, attempts, next_attempt_at, last_error_code,
          first_seen_at, last_seen_at, completed_at)
       VALUES ('order', $1::bigint, $2::varchar, $3::timestamptz, $4::varchar, $5::varchar,
               1,
               now(),
               $6::varchar, now(), now(),
               CASE WHEN $5::varchar = 'completed' THEN now() ELSE NULL END)
       ON CONFLICT (source_type, source_id) DO UPDATE
         SET source_revision_sha256 = EXCLUDED.source_revision_sha256,
             source_modified_at = COALESCE(EXCLUDED.source_modified_at, woocommerce_sync_items.source_modified_at),
             last_seen_at = now(),
             lane = EXCLUDED.lane,
             status = EXCLUDED.status,
             attempts = CASE
               WHEN EXCLUDED.status = 'completed' THEN woocommerce_sync_items.attempts
               ELSE woocommerce_sync_items.attempts + 1
             END,
             last_error_code = EXCLUDED.last_error_code,
             completed_at = CASE
               WHEN EXCLUDED.status = 'completed' THEN now()
               ELSE woocommerce_sync_items.completed_at
             END,
             claim_fencing_token = NULL,
             claimed_revision_sha256 = NULL,
             claim_until = NULL,
             next_attempt_at = CASE
               WHEN EXCLUDED.status = 'completed' THEN now()
               ELSE now() + interval '30 seconds'
             END
       RETURNING id, status, attempts, last_error_code`,
      [
        sourceId,
        revisionSha256,
        modifiedAt,
        lane,
        outcome,
        errorCode ? String(errorCode).slice(0, 128) : null,
      ],
    );
    return result.rows[0];
  }

  /**
   * Requeue quarantined (and optionally failed) order rows for another attempt.
   * Used by reconcile --apply and post-catalog repair — quarantine is not terminal.
   */
  async requeueOrders({ statuses = ["quarantined", "failed"], errorCodes = null, limit = 5000 } = {}) {
    const params = [statuses, limit];
    let errorFilter = "";
    if (Array.isArray(errorCodes) && errorCodes.length > 0) {
      errorFilter = " AND last_error_code = ANY($3::text[])";
      params.push(errorCodes);
    }
    const result = await this.pool.query(
      `WITH due AS (
         SELECT id
           FROM woocommerce_sync_items
          WHERE source_type = 'order'
            AND status = ANY($1::text[])
            ${errorFilter}
          ORDER BY id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE woocommerce_sync_items AS item
          SET status = 'pending',
              lane = 'hourly',
              next_attempt_at = now(),
              claim_fencing_token = NULL,
              claimed_revision_sha256 = NULL,
              claim_until = NULL
         FROM due
        WHERE item.id = due.id
      RETURNING item.id, item.source_id, item.last_error_code`,
      params,
    );
    return result.rows;
  }

  async promoteHourly() {
    const result = await this.pool.query(
      `UPDATE woocommerce_sync_items SET lane = 'hourly', status = 'pending', next_attempt_at = now()
        WHERE status = 'completed' AND last_seen_at > COALESCE(completed_at, '-infinity'::timestamptz)
      RETURNING id`,
    );
    return result.rowCount;
  }

  async metric({ stage, outcome, durationMs = 0, itemCount = 0, byteCount = 0, errorCode = null, detail = {} }) {
    const memory = process.memoryUsage();
    await this.pool.query(
      `INSERT INTO woocommerce_sync_metrics
         (stage, outcome, duration_ms, item_count, byte_count, rss_bytes, heap_bytes, error_code, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [stage, outcome, Math.max(0, Math.round(durationMs)), itemCount, byteCount, memory.rss, memory.heapUsed, errorCode, JSON.stringify(detail)],
    );
  }

  async startCampaign(campaignKey, scheduledFor, token) {
    const result = await this.pool.query(
      `INSERT INTO woocommerce_sync_campaigns
         (campaign_key, kind, status, current_step, fencing_token, scheduled_for, started_at, updated_at)
       VALUES ($1, 'friday-cutover', 'running', 'new-products', $3, $2, now(), now())
       ON CONFLICT (campaign_key) DO UPDATE
         SET status = CASE
               WHEN woocommerce_sync_campaigns.status IN ('completed', 'completed-with-exceptions', 'missed')
                 THEN woocommerce_sync_campaigns.status
               ELSE 'running'
             END,
             fencing_token = CASE
               WHEN woocommerce_sync_campaigns.status IN ('completed', 'completed-with-exceptions', 'missed')
                 THEN woocommerce_sync_campaigns.fencing_token
               ELSE $3
             END,
             updated_at = now()
       RETURNING *`,
      [campaignKey, scheduledFor, token],
    );
    return result.rows[0];
  }

  async campaignStep(campaignKey, token, step, metrics = {}) {
    const result = await this.pool.query(
      `UPDATE woocommerce_sync_campaigns
          SET current_step = $3, metrics = metrics || $4::jsonb, updated_at = now()
        WHERE campaign_key = $1 AND fencing_token = $2 AND status = 'running'
      RETURNING id`,
      [campaignKey, token, step, JSON.stringify(metrics)],
    );
    if (result.rowCount !== 1) throw Object.assign(new Error("Woo sync campaign fence rejected"), { code: "WOOCOMMERCE_SYNC_FENCE_REJECTED" });
  }

  async markMissedCampaign(campaignKey, scheduledFor, errorCode) {
    const result = await this.pool.query(
      `INSERT INTO woocommerce_sync_campaigns
         (campaign_key, kind, status, current_step, scheduled_for, finished_at, last_error_code, updated_at)
       VALUES ($1, 'friday-cutover', 'missed', 'not-started', $2, now(), $3, now())
       ON CONFLICT (campaign_key) DO NOTHING
       RETURNING *`,
      [campaignKey, scheduledFor, errorCode],
    );
    return result.rows[0] || null;
  }

  async finishCampaign(campaignKey, token, status, errorCode = null) {
    const result = await this.pool.query(
      `UPDATE woocommerce_sync_campaigns
          SET status = $3, finished_at = now(), last_error_code = $4, updated_at = now()
        WHERE campaign_key = $1 AND fencing_token = $2 AND status = 'running'
      RETURNING id`,
      [campaignKey, token, status, errorCode],
    );
    if (result.rowCount !== 1) throw Object.assign(new Error("Woo sync campaign fence rejected"), { code: "WOOCOMMERCE_SYNC_FENCE_REJECTED" });
  }
}

module.exports = { SyncStateStore };
