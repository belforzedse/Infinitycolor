"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RUN_STATUSES = [
  "pending",
  "running",
  "paused",
  "failed",
  "completed",
  "cancelled",
  "resumable",
];

const RESUMABLE_STATUSES = new Set(["pending", "paused", "failed", "cancelled", "resumable"]);

function nowIso() {
  return new Date().toISOString();
}

function sanitizeRunId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function createRunId(prefix = "run") {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function sanitizeError(error) {
  if (!error) return "";
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/consumer_secret=[^&\s]+/gi, "consumer_secret=[redacted]")
    .replace(/consumer_key=[^&\s]+/gi, "consumer_key=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

class CatalogRunStore {
  /**
   * @param {string} trackingDir
   * @param {object} [opts]
   * @param {number} [opts.lockStaleMs]
   */
  constructor(trackingDir, opts = {}) {
    this.trackingDir = trackingDir;
    this.runsDir = path.join(trackingDir, "catalog-runs");
    this.indexPath = path.join(trackingDir, "catalog-runs.json");
    this.lockStaleMs = opts.lockStaleMs || 30 * 60 * 1000;
  }

  ensure() {
    fs.mkdirSync(this.runsDir, { recursive: true });
    if (!fs.existsSync(this.indexPath)) {
      atomicWriteJson(this.indexPath, { version: 1, runs: [] });
    }
  }

  runPath(runId) {
    return path.join(this.runsDir, `${sanitizeRunId(runId)}.json`);
  }

  readIndex() {
    this.ensure();
    const index = readJson(this.indexPath, { version: 1, runs: [] });
    if (!Array.isArray(index.runs)) index.runs = [];
    return index;
  }

  writeIndex(index) {
    atomicWriteJson(this.indexPath, {
      version: 1,
      runs: Array.isArray(index.runs) ? index.runs.slice(0, 200) : [],
    });
  }

  getRun(runId) {
    const run = readJson(this.runPath(runId), null);
    if (!run) {
      throw new Error(`Catalog run not found: ${runId}`);
    }
    if (!run.items) run.items = {};
    if (!run.failures) run.failures = [];
    if (!run.checkpoints) run.checkpoints = {};
    return run;
  }

  listRuns({ statuses } = {}) {
    const index = this.readIndex();
    const allowed = statuses ? new Set(statuses) : null;
    const includeStaleRunning = allowed && Array.from(allowed).some((status) => RESUMABLE_STATUSES.has(status));
    return index.runs
      .map((summary) => {
        if (!includeStaleRunning || summary.status !== "running") return summary;
        try {
          return this.summarize(this.getRun(summary.id));
        } catch {
          return summary;
        }
      })
      .filter((run) => !allowed || allowed.has(run.status) || (includeStaleRunning && this.isResumable(run)));
  }

  createRun({ runId, command, environment, strapiBaseUrl, options }) {
    this.ensure();
    const id = sanitizeRunId(runId || createRunId(command || "catalog"));
    if (fs.existsSync(this.runPath(id))) {
      throw new Error(`Catalog run already exists: ${id}`);
    }
    const createdAt = nowIso();
    const run = {
      version: 1,
      id,
      command: command || "sync",
      environment,
      strapiBaseUrl,
      options: { ...(options || {}) },
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      currentStep: "pending",
      checkpoints: {},
      totals: {
        totalItems: 0,
        processedItems: 0,
        skippedItems: 0,
        failedItems: 0,
      },
      counters: null,
      media: null,
      failures: [],
      items: {},
      lock: null,
      cancelRequested: false,
      pauseRequested: false,
    };
    atomicWriteJson(this.runPath(id), run);
    this.upsertSummary(run);
    return run;
  }

  upsertSummary(run) {
    const index = this.readIndex();
    const summary = this.summarize(run);
    const existingIndex = index.runs.findIndex((item) => item.id === run.id);
    if (existingIndex >= 0) {
      index.runs[existingIndex] = summary;
    } else {
      index.runs.unshift(summary);
    }
    index.runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    this.writeIndex(index);
  }

  summarize(run) {
    return {
      id: run.id,
      command: run.command,
      environment: run.environment,
      status: run.status,
      currentStep: run.currentStep,
      scope: run.options?.scope,
      dryRun: Boolean(run.options?.dryRun),
      limit: run.options?.limit,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      totals: run.totals,
      failures: Array.isArray(run.failures) ? run.failures.length : 0,
      lock: run.lock
        ? {
            pid: run.lock.pid,
            hostname: run.lock.hostname,
            acquiredAt: run.lock.acquiredAt,
            heartbeatAt: run.lock.heartbeatAt,
            stale: this.isLockStale(run.lock),
          }
        : null,
    };
  }

  updateRun(runId, updater) {
    const run = this.getRun(runId);
    const next = updater(run) || run;
    next.updatedAt = nowIso();
    atomicWriteJson(this.runPath(runId), next);
    this.upsertSummary(next);
    return next;
  }

  setStatus(runId, status, fields = {}) {
    if (!RUN_STATUSES.includes(status)) {
      throw new Error(`Invalid catalog run status: ${status}`);
    }
    return this.updateRun(runId, (run) => {
      run.status = status;
      Object.assign(run, fields);
      if (status === "running" && !run.startedAt) run.startedAt = nowIso();
      if (["failed", "completed", "cancelled", "resumable", "paused"].includes(status)) {
        run.finishedAt = fields.finishedAt || nowIso();
      }
      return run;
    });
  }

  isLockStale(lock) {
    if (!lock?.heartbeatAt) return false;
    return Date.now() - new Date(lock.heartbeatAt).getTime() > this.lockStaleMs;
  }

  acquireLock(runId) {
    const token = crypto.randomBytes(16).toString("hex");
    this.updateRun(runId, (run) => {
      if (run.lock && !this.isLockStale(run.lock)) {
        throw new Error(`Catalog run ${runId} is already locked by pid ${run.lock.pid}`);
      }
      run.lock = {
        token,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: nowIso(),
        heartbeatAt: nowIso(),
      };
      run.status = "running";
      if (!run.startedAt) run.startedAt = nowIso();
      return run;
    });
    return token;
  }

  heartbeat(runId, token) {
    return this.updateRun(runId, (run) => {
      if (run.lock?.token === token) {
        run.lock.heartbeatAt = nowIso();
      }
      return run;
    });
  }

  releaseLock(runId, token) {
    return this.updateRun(runId, (run) => {
      if (!token || run.lock?.token === token) {
        run.lock = null;
      }
      return run;
    });
  }

  requestCancel(runId) {
    return this.updateRun(runId, (run) => {
      run.cancelRequested = true;
      if (run.status !== "running") {
        run.status = "cancelled";
        run.finishedAt = nowIso();
      }
      return run;
    });
  }

  requestPause(runId) {
    return this.updateRun(runId, (run) => {
      run.pauseRequested = true;
      return run;
    });
  }

  setCurrentStep(runId, currentStep, checkpoint = {}) {
    return this.updateRun(runId, (run) => {
      run.currentStep = currentStep;
      run.checkpoints[currentStep] = {
        ...(run.checkpoints[currentStep] || {}),
        ...checkpoint,
        updatedAt: nowIso(),
      };
      return run;
    });
  }

  getItem(runId, key) {
    const run = this.getRun(runId);
    return run.items[key] || null;
  }

  beginItem(runId, key, detail = {}) {
    return this.updateRun(runId, (run) => {
      const previous = run.items[key] || {};
      run.items[key] = {
        ...previous,
        ...detail,
        key,
        status: "running",
        attempts: (previous.attempts || 0) + 1,
        startedAt: previous.startedAt || nowIso(),
        updatedAt: nowIso(),
      };
      run.totals.totalItems = Object.keys(run.items).length;
      return run;
    });
  }

  completeItem(runId, key, detail = {}) {
    return this.updateRun(runId, (run) => {
      const previous = run.items[key] || { key, attempts: 0 };
      run.items[key] = {
        ...previous,
        ...detail,
        key,
        status: detail.status || "completed",
        error: null,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.refreshTotals(run);
      return run;
    });
  }

  failItem(runId, key, detail = {}) {
    return this.updateRun(runId, (run) => {
      const previous = run.items[key] || { key, attempts: 0 };
      const failure = {
        key,
        entity: detail.entity,
        wcId: detail.wcId,
        stage: detail.stage,
        error: sanitizeError(detail.error),
        at: nowIso(),
      };
      run.items[key] = {
        ...previous,
        ...detail,
        key,
        status: "failed",
        error: failure.error,
        failedAt: failure.at,
        updatedAt: failure.at,
      };
      run.failures.push(failure);
      this.refreshTotals(run);
      return run;
    });
  }

  refreshTotals(run) {
    const items = Object.values(run.items || {});
    run.totals = {
      totalItems: items.length,
      processedItems: items.filter((item) => item.status === "completed").length,
      skippedItems: items.filter((item) => item.status === "skipped").length,
      failedItems: items.filter((item) => item.status === "failed").length,
    };
  }

  shouldSkipItem(runId, key, { retryFailed = false } = {}) {
    const item = this.getItem(runId, key);
    if (!item) return false;
    if (item.status === "completed" || item.status === "skipped") return true;
    if (item.status === "failed" && !retryFailed) return true;
    return false;
  }

  isResumable(run) {
    if (RESUMABLE_STATUSES.has(run.status)) return true;
    return run.status === "running" && Boolean(run.lock) && this.isLockStale(run.lock);
  }

  finalizeFromReport(runId, reportJson, status) {
    return this.updateRun(runId, (run) => {
      run.status = status;
      run.finishedAt = nowIso();
      run.currentStep = status;
      run.counters = reportJson.entities;
      run.media = reportJson.media;
      run.report = {
        runAt: reportJson.runAt,
        command: reportJson.command,
        durationMs: reportJson.durationMs,
        failures: reportJson.failures?.length || 0,
      };
      this.refreshTotals(run);
      return run;
    });
  }
}

module.exports = {
  CatalogRunStore,
  RUN_STATUSES,
  RESUMABLE_STATUSES,
  createRunId,
  sanitizeError,
};
