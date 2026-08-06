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
  "completed-with-exceptions",
  "cancelled",
  "resumable",
];
const TERMINAL_STATUSES = new Set(["failed", "completed", "completed-with-exceptions", "cancelled", "resumable"]);
const RESUMABLE_STATUSES = new Set(["pending", "paused", "failed", "cancelled", "resumable"]);
const JOURNAL_VERSION = 2;
const DEFAULT_COMPACT_EVENTS = 10_000;
const DEFAULT_COMPACT_BYTES = 64 * 1024 * 1024;

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

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM"]).has(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWriteJson(filePath, value, { durable = true, mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (durable) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const retryableCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
    let renamed = false;
    let lastError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.renameSync(tmp, filePath);
        renamed = true;
        break;
      } catch (error) {
        lastError = error;
        if (!retryableCodes.has(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(1000, 25 * (attempt + 1)));
      }
    }
    if (!renamed) throw lastError;
    if (durable) fsyncDirectory(path.dirname(filePath));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; the uniquely named temp file is never read as state.
    }
  }
}

function readJsonStrict(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return readJsonStrict(filePath);
  } catch {
    return fallback;
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function projectionDigest(run) {
  return sha256Buffer(Buffer.from(stableStringify({
    id: run.id,
    status: run.status,
    totals: run.totals,
    items: run.items,
    failures: run.failures,
    acceptedExceptions: run.acceptedExceptions || null,
  })));
}

function conversionProjectionDigest(run, version = 2) {
  const projection = {
    id: run.id,
    status: run.status,
    totals: run.totals,
    items: run.items,
    failures: run.failures,
  };
  if (version >= 2) projection.acceptedExceptions = run.acceptedExceptions || null;
  return sha256Buffer(Buffer.from(stableStringify(projection)));
}

function sanitizeError(error) {
  if (!error) return "";
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => `[url-sha256:${sha256Buffer(Buffer.from(url)).slice(0, 16)}]`)
    .replace(/consumer_secret=[^&\s]+/gi, "consumer_secret=[redacted]")
    .replace(/consumer_key=[^&\s]+/gi, "consumer_key=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(authorization|password|token|secret)(["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1$2[redacted]");
}

function ensureRunShape(run) {
  if (!run || typeof run !== "object") throw new Error("Invalid catalog run projection");
  if (!run.items || typeof run.items !== "object" || Array.isArray(run.items)) run.items = {};
  if (!Array.isArray(run.failures)) run.failures = [];
  if (run.acceptedExceptions !== null && run.acceptedExceptions !== undefined && typeof run.acceptedExceptions !== "object") {
    throw new Error("Invalid accepted catalog exceptions");
  }
  if (!run.checkpoints || typeof run.checkpoints !== "object") run.checkpoints = {};
  if (!run.totals || typeof run.totals !== "object") {
    run.totals = { totalItems: 0, processedItems: 0, skippedItems: 0, failedItems: 0 };
  }
  if (!run.metrics || typeof run.metrics !== "object") run.metrics = {};
  return run;
}

function statusTotalKey(status) {
  if (status === "completed") return "processedItems";
  if (status === "skipped") return "skippedItems";
  if (status === "failed") return "failedItems";
  return null;
}

function transitionItem(run, key, next) {
  const previous = run.items[key];
  if (!previous) run.totals.totalItems += 1;
  const oldTotal = statusTotalKey(previous?.status);
  const newTotal = statusTotalKey(next.status);
  if (oldTotal && oldTotal !== newTotal) run.totals[oldTotal] = Math.max(0, Number(run.totals[oldTotal] || 0) - 1);
  if (newTotal && oldTotal !== newTotal) run.totals[newTotal] = Number(run.totals[newTotal] || 0) + 1;
  run.items[key] = next;
}

function applyEvent(run, event) {
  if (event.operation === "item-transition") {
    transitionItem(run, event.itemKey, event.detail.item);
    if (event.detail.failure) run.failures.push(event.detail.failure);
  } else if (event.operation === "run-update") {
    Object.assign(run, event.detail.patch || {});
  } else {
    throw new Error(`Unknown catalog journal operation: ${event.operation}`);
  }
  run.updatedAt = event.timestamp;
}

function comparableProjection(run) {
  return {
    items: run.items,
    totals: run.totals,
    failures: run.failures,
    status: run.status,
  };
}

class CatalogRunStore {
  constructor(trackingDir, opts = {}) {
    this.trackingDir = trackingDir;
    this.runsDir = path.join(trackingDir, "catalog-runs");
    this.indexPath = path.join(trackingDir, "catalog-runs.json");
    this.lockStaleMs = opts.lockStaleMs || 60_000;
    this.compactEvents = opts.compactEvents || DEFAULT_COMPACT_EVENTS;
    this.compactBytes = opts.compactBytes || DEFAULT_COMPACT_BYTES;
    this.projections = new Map();
  }

  ensure() {
    fs.mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.indexPath)) atomicWriteJson(this.indexPath, { version: 2, runs: [] });
  }

  runPath(runId) {
    return path.join(this.runsDir, `${sanitizeRunId(runId)}.json`);
  }

  runDir(runId) {
    return path.join(this.runsDir, sanitizeRunId(runId));
  }

  snapshotPath(runId) {
    return path.join(this.runDir(runId), "snapshot.json");
  }

  eventsPath(runId) {
    return path.join(this.runDir(runId), "events.ndjson");
  }

  controlPath(runId) {
    return path.join(this.runDir(runId), "control.json");
  }

  controlGuardPath(runId) {
    return path.join(this.runDir(runId), ".control.guard");
  }

  withControlGuard(runId, action) {
    const guardPath = this.controlGuardPath(runId);
    let fd;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        fd = fs.openSync(guardPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(guardPath).mtimeMs > 30_000) fs.unlinkSync(guardPath);
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (fd === undefined) throw new Error(`Timed out acquiring catalog control guard for ${runId}`);
    try {
      return action();
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(guardPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  hasRun(runId) {
    return fs.existsSync(this.snapshotPath(runId)) || fs.existsSync(this.runPath(runId));
  }

  readIndex() {
    this.ensure();
    const index = readJson(this.indexPath, { version: 2, runs: [] });
    if (!Array.isArray(index.runs)) index.runs = [];
    return index;
  }

  writeIndex(index) {
    atomicWriteJson(this.indexPath, { version: 2, runs: Array.isArray(index.runs) ? index.runs.slice(0, 200) : [] });
  }

  readControl(runId, fallbackRun = null) {
    const filePath = this.controlPath(runId);
    if (!fs.existsSync(filePath)) {
      return {
        version: 2,
        runId: sanitizeRunId(runId),
        lock: fallbackRun?.lock || null,
        cancelRequested: Boolean(fallbackRun?.cancelRequested),
        pauseRequested: Boolean(fallbackRun?.pauseRequested),
        updatedAt: fallbackRun?.updatedAt || nowIso(),
      };
    }
    const control = readJsonStrict(filePath);
    if (control.version !== 2 || control.runId !== sanitizeRunId(runId)) {
      throw new Error(`Invalid control metadata for catalog run ${runId}`);
    }
    return control;
  }

  writeControl(runId, control) {
    const id = sanitizeRunId(runId);
    control.version = 2;
    control.runId = id;
    control.updatedAt = nowIso();
    atomicWriteJson(this.controlPath(id), control);
    const projection = this.projections.get(id);
    if (projection && !projection.legacy) projection.control = { ...control };
  }

  validateDualFormat(runId, snapshot) {
    const legacyPath = this.runPath(runId);
    if (!fs.existsSync(legacyPath)) return;
    const conversion = snapshot.conversion;
    if (!conversion || conversion.sourceVersion !== 1 || !conversion.legacySha256 ||
        !/^[a-f0-9]{64}$/i.test(String(conversion.projectionSha256 || ""))) {
      throw new Error(`Catalog run ${runId} has both v1 and v2 state without valid conversion metadata`);
    }
    const legacy = fs.readFileSync(legacyPath);
    if (sha256Buffer(legacy) !== conversion.legacySha256 || legacy.length !== conversion.legacyBytes) {
      throw new Error(`Legacy catalog state hash changed after v2 conversion for ${runId}`);
    }
    const legacyRun = ensureRunShape(JSON.parse(legacy.toString("utf8")));
    const digestVersion = Number(conversion.projectionDigestVersion || 1);
    if (![1, 2].includes(digestVersion) || legacyRun.id !== runId ||
        conversionProjectionDigest(legacyRun, digestVersion) !== conversion.projectionSha256) {
      throw new Error(`Legacy catalog projection does not match conversion metadata for ${runId}`);
    }
  }

  loadProjection(runId) {
    const id = sanitizeRunId(runId);
    if (this.projections.has(id)) return this.projections.get(id);
    const snapshotPath = this.snapshotPath(id);
    if (!fs.existsSync(snapshotPath)) {
      const legacyPath = this.runPath(id);
      if (!fs.existsSync(legacyPath)) throw new Error(`Catalog run not found: ${id}`);
      const run = ensureRunShape(readJsonStrict(legacyPath));
      return { run, control: { lock: run.lock, cancelRequested: run.cancelRequested, pauseRequested: run.pauseRequested }, legacy: true };
    }

    const replayStarted = process.hrtime.bigint();
    const snapshot = readJsonStrict(snapshotPath);
    if (snapshot.version !== JOURNAL_VERSION || !snapshot.run || !Number.isSafeInteger(snapshot.sequence)) {
      throw new Error(`Invalid v2 snapshot for catalog run ${id}`);
    }
    this.validateDualFormat(id, snapshot);
    const run = ensureRunShape(snapshot.run);
    if (run.id !== id) throw new Error(`Snapshot run id mismatch for ${id}`);
    let expected = snapshot.sequence + 1;
    let replayed = 0;
    let journalBytes = 0;
    const eventsPath = this.eventsPath(id);
    if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > 0) {
      const data = fs.readFileSync(eventsPath);
      journalBytes = data.length;
      const text = data.toString("utf8");
      const lines = text.split("\n");
      const hasFinalNewline = text.endsWith("\n");
      const lastIndex = hasFinalNewline ? lines.length - 2 : lines.length - 1;
      for (let index = 0; index <= lastIndex; index += 1) {
        const line = lines[index];
        if (!line) throw new Error(`Empty catalog journal record at line ${index + 1} for ${id}`);
        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          if (index === lastIndex && !hasFinalNewline) break;
          throw new Error(`Corrupt catalog journal record at line ${index + 1} for ${id}: ${error.message}`);
        }
        if (event.version !== JOURNAL_VERSION || event.runId !== id || !Number.isSafeInteger(event.sequence)) {
          throw new Error(`Invalid catalog journal record at line ${index + 1} for ${id}`);
        }
        if (event.sequence <= snapshot.sequence) continue;
        if (event.sequence !== expected) {
          throw new Error(`Catalog journal sequence gap for ${id}: expected ${expected}, got ${event.sequence}`);
        }
        applyEvent(run, event);
        expected += 1;
        replayed += 1;
      }
    }
    const control = this.readControl(id, run);
    delete run.lock;
    delete run.cancelRequested;
    delete run.pauseRequested;
    const projection = {
      run,
      control,
      sequence: expected - 1,
      snapshotSequence: snapshot.sequence,
      eventsSinceSnapshot: replayed,
      journalBytes,
      eventFd: null,
      legacy: false,
      conversion: snapshot.conversion || null,
      journalMetrics: {
        appendCount: Number(snapshot.journalMetrics?.appendCount || 0),
        appendBytes: Number(snapshot.journalMetrics?.appendBytes || 0),
        appendMs: Number(snapshot.journalMetrics?.appendMs || 0),
        syncCount: Number(snapshot.journalMetrics?.syncCount || 0),
        syncMs: Number(snapshot.journalMetrics?.syncMs || 0),
        replayCount: Number(snapshot.journalMetrics?.replayCount || 0) + replayed,
        replayMs: Number(snapshot.journalMetrics?.replayMs || 0) + Number(process.hrtime.bigint() - replayStarted) / 1e6,
        compactionCount: Number(snapshot.journalMetrics?.compactionCount || 0),
        compactionMs: Number(snapshot.journalMetrics?.compactionMs || 0),
        snapshotBytes: fs.statSync(snapshotPath).size,
      },
    };
    this.projections.set(id, projection);
    return projection;
  }

  materialize(projection) {
    if (projection.legacy) return projection.run;
    projection.run.lock = projection.control.lock || null;
    projection.run.cancelRequested = Boolean(projection.control.cancelRequested);
    projection.run.pauseRequested = Boolean(projection.control.pauseRequested);
    projection.run.metrics = projection.run.metrics || {};
    projection.run.metrics.journal = { ...projection.journalMetrics };
    return projection.run;
  }

  getRun(runId) {
    return this.materialize(this.loadProjection(runId));
  }

  listRuns({ statuses } = {}) {
    const allowed = statuses ? new Set(statuses) : null;
    const includeStaleRunning = allowed && Array.from(allowed).some((status) => RESUMABLE_STATUSES.has(status));
    return this.readIndex().runs
      .map((summary) => {
        if (!includeStaleRunning || summary.status !== "running") return summary;
        try { return this.summarize(this.getRun(summary.id)); } catch { return summary; }
      })
      .filter((run) => !allowed || allowed.has(run.status) || (includeStaleRunning && this.isResumable(run)));
  }

  createRun({ runId, command, environment, strapiBaseUrl, options }) {
    this.ensure();
    const id = sanitizeRunId(runId || createRunId(command || "catalog"));
    if (this.hasRun(id)) throw new Error(`Catalog run already exists: ${id}`);
    const createdAt = nowIso();
    const run = ensureRunShape({
      version: 2,
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
      totals: { totalItems: 0, processedItems: 0, skippedItems: 0, failedItems: 0 },
      counters: null,
      media: null,
      failures: [],
      acceptedExceptions: null,
      items: {},
      metrics: {},
    });
    fs.mkdirSync(this.runDir(id), { recursive: false, mode: 0o700 });
    atomicWriteJson(this.snapshotPath(id), { version: 2, sequence: 0, createdAt, run });
    const eventFd = fs.openSync(this.eventsPath(id), "ax", 0o600);
    fs.fsyncSync(eventFd);
    fs.closeSync(eventFd);
    const control = { version: 2, runId: id, lock: null, cancelRequested: false, pauseRequested: false, updatedAt: createdAt };
    this.writeControl(id, control);
    this.projections.delete(id);
    const loaded = this.loadProjection(id);
    this.upsertSummary(this.materialize(loaded));
    return this.materialize(loaded);
  }

  upsertSummary(run) {
    const index = this.readIndex();
    const summary = this.summarize(run);
    const existingIndex = index.runs.findIndex((item) => item.id === run.id);
    if (existingIndex >= 0) index.runs[existingIndex] = summary;
    else index.runs.unshift(summary);
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
      acceptedExceptions: Number(run.acceptedExceptions?.entries?.length || 0),
      exceptionManifestSha256: run.acceptedExceptions?.manifestSha256 || null,
      lock: run.lock ? {
        pid: run.lock.pid,
        hostname: run.lock.hostname,
        acquiredAt: run.lock.acquiredAt,
        heartbeatAt: run.lock.heartbeatAt,
        stale: this.isLockStale(run.lock),
      } : null,
    };
  }

  assertMutable(projection, runId, token) {
    if (projection.legacy) throw new Error(`Catalog run ${runId} is legacy v1; run offline v1-to-v2 conversion first`);
    projection.control = this.readControl(runId, projection.run);
    const owner = projection.control.lock?.token;
    if ((owner && token !== owner) || (!owner && token)) {
      const error = new Error(`Catalog run ${runId} lease is not owned by this process`);
      error.code = "CATALOG_FENCE_REJECTED";
      throw error;
    }
  }

  appendEvent(projection, { operation, itemKey = null, status = null, detail = {}, token = null }) {
    const started = process.hrtime.bigint();
    const event = {
      version: JOURNAL_VERSION,
      sequence: projection.sequence + 1,
      runId: projection.run.id,
      operation,
      itemKey,
      status,
      detail,
      timestamp: nowIso(),
    };
    if (token) event.fencingToken = token;
    const encoded = `${JSON.stringify(event)}\n`;
    if (projection.eventFd === null) projection.eventFd = fs.openSync(this.eventsPath(projection.run.id), "a", 0o600);
    fs.writeSync(projection.eventFd, encoded, null, "utf8");
    applyEvent(projection.run, event);
    projection.sequence = event.sequence;
    projection.eventsSinceSnapshot += 1;
    projection.journalBytes += Buffer.byteLength(encoded);
    projection.journalMetrics.appendCount += 1;
    projection.journalMetrics.appendBytes += Buffer.byteLength(encoded);
    projection.journalMetrics.appendMs += Number(process.hrtime.bigint() - started) / 1e6;
    return event;
  }

  updateRun(runId, updater, token = null) {
    const projection = this.loadProjection(runId);
    return this.withControlGuard(runId, () => {
      this.assertMutable(projection, runId, token);
      projection.run.lock = projection.control.lock || null;
      projection.run.cancelRequested = Boolean(projection.control.cancelRequested);
      projection.run.pauseRequested = Boolean(projection.control.pauseRequested);
      const controlBefore = stableStringify({
        lock: projection.run.lock,
        cancelRequested: projection.run.cancelRequested,
        pauseRequested: projection.run.pauseRequested,
      });
      const before = {};
      for (const [key, value] of Object.entries(projection.run)) {
        if (!new Set(["items", "failures", "metrics", "lock", "cancelRequested", "pauseRequested"]).has(key)) before[key] = stableStringify(value);
      }
      const next = updater(projection.run) || projection.run;
      if (next !== projection.run) projection.run = ensureRunShape(next);
      const controlAfter = stableStringify({
        lock: projection.run.lock,
        cancelRequested: projection.run.cancelRequested,
        pauseRequested: projection.run.pauseRequested,
      });
      if (controlAfter !== controlBefore) {
        projection.control.lock = projection.run.lock || null;
        projection.control.cancelRequested = Boolean(projection.run.cancelRequested);
        projection.control.pauseRequested = Boolean(projection.run.pauseRequested);
        this.writeControl(runId, projection.control);
      }
      const patch = {};
      for (const [key, value] of Object.entries(projection.run)) {
        if (!new Set(["items", "failures", "metrics", "lock", "cancelRequested", "pauseRequested", "updatedAt"]).has(key) && before[key] !== stableStringify(value)) patch[key] = value;
      }
      this.appendEvent(projection, { operation: "run-update", status: projection.run.status, detail: { patch }, token });
      return this.materialize(projection);
    });
  }

  setStatus(runId, status, fields = {}, token = null) {
    if (!RUN_STATUSES.includes(status)) throw new Error(`Invalid catalog run status: ${status}`);
    const run = this.updateRun(runId, (current) => {
      current.status = status;
      Object.assign(current, fields);
      if (status === "running" && !current.startedAt) current.startedAt = nowIso();
      if ([...TERMINAL_STATUSES, "paused"].includes(status)) current.finishedAt = fields.finishedAt || nowIso();
      return current;
    }, token);
    if (TERMINAL_STATUSES.has(status) || status === "paused") {
      this.syncNow(runId, token);
      this.compact(runId, token, { terminal: true });
    }
    return run;
  }

  isLockStale(lock) {
    if (!lock?.heartbeatAt) return false;
    return Date.now() - new Date(lock.heartbeatAt).getTime() > this.lockStaleMs;
  }

  acquireLock(runId) {
    const projection = this.loadProjection(runId);
    if (projection.legacy) throw new Error(`Catalog run ${runId} is legacy v1; convert it before resume`);
    let token;
    let at;
    this.withControlGuard(runId, () => {
      const control = this.readControl(runId, projection.run);
      if (control.lock && !this.isLockStale(control.lock)) {
        throw new Error(`Catalog run ${runId} is already locked by pid ${control.lock.pid}`);
      }
      token = crypto.randomBytes(24).toString("hex");
      at = nowIso();
      control.lock = { token, pid: process.pid, hostname: os.hostname(), acquiredAt: at, heartbeatAt: at };
      control.pauseRequested = false;
      control.cancelRequested = false;
      this.writeControl(runId, control);
      projection.control = control;
    });
    this.updateRun(runId, (run) => {
      run.status = "running";
      run.finishedAt = null;
      if (!run.startedAt) run.startedAt = at;
      return run;
    }, token);
    this.upsertSummary(this.getRun(runId));
    return token;
  }

  heartbeat(runId, token) {
    const projection = this.loadProjection(runId);
    let changed = false;
    this.withControlGuard(runId, () => {
      const control = this.readControl(runId, projection.run);
      if (!control.lock || control.lock.token !== token) {
        const error = new Error(`Catalog run ${runId} heartbeat rejected by fencing token`);
        error.code = "CATALOG_FENCE_REJECTED";
        throw error;
      }
      if (Date.now() - new Date(control.lock.heartbeatAt).getTime() >= 15_000) {
        control.lock.heartbeatAt = nowIso();
        this.writeControl(runId, control);
        changed = true;
      }
      projection.control = control;
    });
    if (changed) this.upsertSummary(this.materialize(projection));
    return this.materialize(projection);
  }

  releaseLock(runId, token) {
    const projection = this.loadProjection(runId);
    this.withControlGuard(runId, () => {
      const control = this.readControl(runId, projection.run);
      if (control.lock && control.lock.token !== token) {
        const error = new Error(`Catalog run ${runId} lock release rejected by fencing token`);
        error.code = "CATALOG_FENCE_REJECTED";
        throw error;
      }
      control.lock = null;
      this.writeControl(runId, control);
      projection.control = control;
    });
    this.upsertSummary(this.materialize(projection));
    return this.materialize(projection);
  }

  requestCancel(runId) {
    const projection = this.loadProjection(runId);
    if (projection.legacy) throw new Error(`Catalog run ${runId} is legacy v1; use its legacy cancellation control`);
    this.withControlGuard(runId, () => {
      const control = this.readControl(runId, projection.run);
      control.cancelRequested = true;
      this.writeControl(runId, control);
      projection.control = control;
    });
    this.syncNow(runId, projection.control.lock?.token || null, { allowExternalControl: true });
    this.upsertSummary(this.materialize(projection));
    return this.materialize(projection);
  }

  requestPause(runId) {
    const projection = this.loadProjection(runId);
    if (projection.legacy) throw new Error(`Catalog run ${runId} is legacy v1; convert it before pause control`);
    this.withControlGuard(runId, () => {
      const control = this.readControl(runId, projection.run);
      control.pauseRequested = true;
      this.writeControl(runId, control);
      projection.control = control;
    });
    this.syncNow(runId, projection.control.lock?.token || null, { allowExternalControl: true });
    this.upsertSummary(this.materialize(projection));
    return this.materialize(projection);
  }

  setCurrentStep(runId, currentStep, checkpoint = {}, token = null) {
    return this.updateRun(runId, (run) => {
      run.currentStep = currentStep;
      run.checkpoints[currentStep] = { ...(run.checkpoints[currentStep] || {}), ...checkpoint, updatedAt: nowIso() };
      return run;
    }, token);
  }

  getItem(runId, key) {
    return this.loadProjection(runId).run.items[key] || null;
  }

  mutateItem(runId, key, nextItem, failure, token) {
    const projection = this.loadProjection(runId);
    return this.withControlGuard(runId, () => {
      this.assertMutable(projection, runId, token);
      this.appendEvent(projection, {
        operation: "item-transition",
        itemKey: key,
        status: nextItem.status,
        detail: { item: nextItem, ...(failure ? { failure } : {}) },
        token,
      });
      return this.materialize(projection);
    });
  }

  beginItem(runId, key, detail = {}, token = null) {
    const previous = this.getItem(runId, key) || {};
    const at = nowIso();
    return this.mutateItem(runId, key, {
      ...previous,
      ...detail,
      key,
      status: "running",
      attempts: Number(previous.attempts || 0) + 1,
      startedAt: previous.startedAt || at,
      updatedAt: at,
    }, null, token);
  }

  completeItem(runId, key, detail = {}, token = null) {
    const previous = this.getItem(runId, key) || { key, attempts: 0 };
    const at = nowIso();
    return this.mutateItem(runId, key, {
      ...previous,
      ...detail,
      key,
      status: detail.status || "completed",
      error: null,
      completedAt: at,
      updatedAt: at,
    }, null, token);
  }

  failItem(runId, key, detail = {}, token = null) {
    const previous = this.getItem(runId, key) || { key, attempts: 0 };
    const at = nowIso();
    const failure = {
      key,
      entity: detail.entity,
      wcId: detail.wcId,
      stage: detail.stage,
      error: sanitizeError(detail.error),
      at,
    };
    return this.mutateItem(runId, key, {
      ...previous,
      ...detail,
      error: failure.error,
      key,
      status: "failed",
      failedAt: at,
      updatedAt: at,
    }, failure, token);
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

  syncNow(runId, token = null, { allowExternalControl = false } = {}) {
    const projection = this.loadProjection(runId);
    if (!allowExternalControl) this.assertMutable(projection, runId, token);
    if (projection.legacy) return this.materialize(projection);
    if (projection.eventFd === null) projection.eventFd = fs.openSync(this.eventsPath(runId), "a", 0o600);
    const started = process.hrtime.bigint();
    fs.fdatasyncSync(projection.eventFd);
    projection.journalMetrics.syncCount += 1;
    projection.journalMetrics.syncMs += Number(process.hrtime.bigint() - started) / 1e6;
    return this.materialize(projection);
  }

  syncBoundary(runId, token = null, { mediaStore = null } = {}) {
    if (mediaStore?.syncBoundary) mediaStore.syncBoundary();
    const run = this.syncNow(runId, token);
    const projection = this.loadProjection(runId);
    this.upsertSummary(run);
    if (projection.eventsSinceSnapshot >= this.compactEvents || projection.journalBytes >= this.compactBytes) {
      this.compact(runId, token);
    }
    return run;
  }

  compact(runId, token = null, { terminal = false } = {}) {
    const projection = this.loadProjection(runId);
    return this.withControlGuard(runId, () => {
      this.assertMutable(projection, runId, token);
      if (!terminal && projection.eventsSinceSnapshot === 0) return this.materialize(projection);
      this.syncNow(runId, token);
      const started = process.hrtime.bigint();
      if (projection.eventFd !== null) {
        fs.closeSync(projection.eventFd);
        projection.eventFd = null;
      }
      const run = projection.run;
      delete run.lock;
      delete run.cancelRequested;
      delete run.pauseRequested;
      const envelope = {
        version: 2,
        sequence: projection.sequence,
        compactedAt: nowIso(),
        ...(projection.conversion ? { conversion: projection.conversion } : {}),
        journalMetrics: {
          ...projection.journalMetrics,
          compactionCount: projection.journalMetrics.compactionCount + 1,
        },
        run,
      };
      atomicWriteJson(this.snapshotPath(runId), envelope);
      const emptyTmp = `${this.eventsPath(runId)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      const fd = fs.openSync(emptyTmp, "wx", 0o600);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(emptyTmp, this.eventsPath(runId));
      fsyncDirectory(this.runDir(runId));
      projection.snapshotSequence = projection.sequence;
      projection.eventsSinceSnapshot = 0;
      projection.journalBytes = 0;
      projection.journalMetrics.compactionCount += 1;
      projection.journalMetrics.compactionMs += Number(process.hrtime.bigint() - started) / 1e6;
      projection.journalMetrics.snapshotBytes = fs.statSync(this.snapshotPath(runId)).size;
      this.upsertSummary(this.materialize(projection));
      return this.materialize(projection);
    });
  }

  finalizeFromReport(runId, reportJson, status, token = null) {
    return this.setStatus(runId, status, {
      currentStep: status,
      counters: reportJson.entities,
      media: reportJson.media,
      report: {
        runAt: reportJson.runAt,
        command: reportJson.command,
        durationMs: reportJson.durationMs,
        failures: reportJson.failures?.length || 0,
      },
      metrics: { ...(this.getRun(runId).metrics || {}), ...(reportJson.metrics || {}) },
    }, token);
  }

  exceptionAudit(runId) {
    const run = this.getRun(runId);
    const entries = Object.entries(run.items || {})
      .filter(([, item]) => item?.status === "failed" || item?.status === "running")
      .map(([key, item]) => ({
        key,
        entity: String(item.entity || ""),
        wcId: item.wcId === undefined || item.wcId === null ? null : String(item.wcId),
        parentWcId: item.parentWcId === undefined || item.parentWcId === null ? null : String(item.parentWcId),
        stage: String(item.stage || ""),
        errorSha256: sha256Buffer(Buffer.from(String(item.error || ""))),
        sourceRevisionSha256: null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return {
      version: 1,
      runId: run.id,
      projectionSha256: projectionDigest(run),
      generatedAt: nowIso(),
      status: run.status,
      entries,
    };
  }

  acceptExceptions(runId, manifest, { confirm = "" } = {}) {
    if (confirm !== "CatalogExceptionsAccepted") {
      throw new Error("Accepted catalog exceptions require --confirm CatalogExceptionsAccepted");
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("Catalog exception manifest must be an object");
    }
    const projection = this.loadProjection(runId);
    if (projection.legacy) throw new Error(`Catalog run ${runId} is legacy v1; convert it before accepting exceptions`);

    let accepted;
    this.withControlGuard(runId, () => {
      projection.control = this.readControl(runId, projection.run);
      if (projection.control.lock) throw new Error(`Catalog run ${runId} has an active or stale lease; release it before accepting exceptions`);
      const run = projection.run;
      if (!["failed", "resumable", "paused", "cancelled"].includes(run.status)) {
        throw new Error(`Catalog run ${runId} cannot accept exceptions from status ${run.status}`);
      }
      if (String(manifest.runId || "") !== run.id) throw new Error("Catalog exception manifest run id mismatch");
      const digest = projectionDigest(run);
      if (String(manifest.projectionSha256 || "") !== digest) {
        throw new Error("Catalog exception manifest projection digest mismatch");
      }
      for (const field of ["approvedBy", "approvalReference", "dependencyAuditSha256"]) {
        if (!String(manifest[field] || "").trim()) throw new Error(`Catalog exception manifest requires ${field}`);
      }
      if (!/^[a-f0-9]{64}$/i.test(String(manifest.dependencyAuditSha256))) {
        throw new Error("Catalog exception dependency audit digest must be SHA-256");
      }

      const current = this.exceptionAudit(runId).entries;
      const supplied = Array.isArray(manifest.entries) ? manifest.entries : [];
      const byKey = new Map();
      for (const entry of supplied) {
        const key = String(entry?.key || "");
        if (!key || byKey.has(key)) throw new Error("Catalog exception manifest contains a missing or duplicate item key");
        for (const field of ["reasonCode", "containment", "impact", "retryCondition", "sourceRevisionSha256"]) {
          if (!String(entry?.[field] || "").trim()) throw new Error(`Catalog exception ${key} requires ${field}`);
        }
        if (entry.acceptEligible !== true) {
          throw new Error(`Catalog exception ${key} is not marked acceptEligible`);
        }
        if (/^(UNCLASSIFIED|AUTH|AMBIGUOUS|DUPLICATE|SOURCE_WRITE_GUARD)/i.test(String(entry.reasonCode))) {
          throw new Error(`Catalog exception ${key} has a fail-closed reason code`);
        }
        if (!/^[a-f0-9]{64}$/i.test(String(entry.sourceRevisionSha256))) {
          throw new Error(`Catalog exception ${key} source revision must be SHA-256`);
        }
        byKey.set(key, entry);
      }
      if (current.length === 0) throw new Error(`Catalog run ${runId} has no failed or running items to accept`);
      if (byKey.size !== current.length || current.some((entry) => !byKey.has(entry.key))) {
        throw new Error("Catalog exception manifest must account for every failed or running item exactly once");
      }
      const entries = current.map((item) => {
        const suppliedEntry = byKey.get(item.key);
        if (String(suppliedEntry.errorSha256 || "") !== item.errorSha256) {
          throw new Error(`Catalog exception ${item.key} error digest mismatch`);
        }
        return {
          ...item,
          sourceRevisionSha256: String(suppliedEntry.sourceRevisionSha256).toLowerCase(),
          reasonCode: String(suppliedEntry.reasonCode).trim(),
          containment: String(suppliedEntry.containment).trim(),
          impact: String(suppliedEntry.impact).trim(),
          retryCondition: String(suppliedEntry.retryCondition).trim(),
          acceptEligible: true,
        };
      });
      const canonicalManifest = {
        version: 1,
        runId: run.id,
        projectionSha256: digest,
        approvedBy: String(manifest.approvedBy).trim(),
        approvalReference: String(manifest.approvalReference).trim(),
        dependencyAuditSha256: String(manifest.dependencyAuditSha256).toLowerCase(),
        dependentOrderIds: Array.from(new Set((manifest.dependentOrderIds || []).map(String))).sort(),
        entries,
      };
      const acceptedAt = nowIso();
      accepted = {
        ...canonicalManifest,
        acceptedAt,
        manifestSha256: sha256Buffer(Buffer.from(stableStringify(canonicalManifest))),
      };
      this.appendEvent(projection, {
        operation: "run-update",
        status: "completed-with-exceptions",
        detail: {
          patch: {
            status: "completed-with-exceptions",
            currentStep: "completed-with-exceptions",
            finishedAt: acceptedAt,
            acceptedExceptions: accepted,
          },
        },
      });
    });
    this.syncNow(runId);
    this.compact(runId, null, { terminal: true });
    this.upsertSummary(this.getRun(runId));
    return { ...accepted, status: "completed-with-exceptions" };
  }

  convertLegacy(runId, { dryRun = true, confirm = "" } = {}) {
    this.ensure();
    const id = sanitizeRunId(runId);
    const legacyPath = this.runPath(id);
    if (!fs.existsSync(legacyPath)) throw new Error(`Legacy catalog run not found: ${id}`);
    const legacyBytes = fs.readFileSync(legacyPath);
    const targetOwner = fs.statSync(this.runsDir);
    const legacy = ensureRunShape(JSON.parse(legacyBytes.toString("utf8")));
    if (legacy.id !== id) throw new Error(`Legacy catalog run id mismatch for ${id}`);
    const projectionDigestVersion = 2;
    const digest = conversionProjectionDigest(legacy, projectionDigestVersion);
    const report = {
      runId: id,
      dryRun: Boolean(dryRun),
      legacyPath,
      legacyBytes: legacyBytes.length,
      legacySha256: sha256Buffer(legacyBytes),
      itemCount: Object.keys(legacy.items).length,
      failureCount: legacy.failures.length,
      totals: legacy.totals,
      projectionSha256: digest,
      projectionDigestVersion,
    };
    if (fs.existsSync(this.snapshotPath(id))) {
      if (!dryRun) throw new Error(`V2 catalog state already exists for ${id}; refusing to overwrite it`);
      const snapshot = readJsonStrict(this.snapshotPath(id));
      this.validateDualFormat(id, snapshot);
      this.projections.delete(id);
      const replayed = this.getRun(id);
      const replayDigest = projectionDigest(replayed);
      return {
        ...report,
        existingV2: true,
        convertedAt: snapshot.conversion.convertedAt,
        replayProjectionSha256: replayDigest,
        conversionEquivalent: snapshot.conversion.projectionSha256 === conversionProjectionDigest(
          legacy,
          Number(snapshot.conversion.projectionDigestVersion || 1),
        ),
        replayValid: true,
        advancedSinceConversion: replayDigest !== digest,
      };
    }
    if (dryRun) return report;
    if (confirm !== "CatalogStateV2") throw new Error("Confirmed conversion requires --confirm CatalogStateV2");

    const tempDir = `${this.runDir(id)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.mkdirSync(tempDir, { mode: 0o700 });
    const convertedAt = nowIso();
    const run = { ...legacy, version: 2 };
    delete run.lock;
    delete run.cancelRequested;
    delete run.pauseRequested;
    const conversion = {
      sourceVersion: 1,
      convertedAt,
      legacyFile: path.basename(legacyPath),
      legacyBytes: legacyBytes.length,
      legacySha256: report.legacySha256,
      projectionSha256: digest,
      projectionDigestVersion,
    };
    atomicWriteJson(path.join(tempDir, "snapshot.json"), { version: 2, sequence: 0, conversion, run });
    let fd = fs.openSync(path.join(tempDir, "events.ndjson"), "wx", 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    atomicWriteJson(path.join(tempDir, "control.json"), {
      version: 2,
      runId: id,
      lock: null,
      cancelRequested: false,
      pauseRequested: false,
      updatedAt: convertedAt,
    });
    for (const target of [
      path.join(tempDir, "snapshot.json"),
      path.join(tempDir, "events.ndjson"),
      path.join(tempDir, "control.json"),
      tempDir,
    ]) {
      const stat = fs.statSync(target);
      if (targetOwner.uid >= 0 && (stat.uid !== targetOwner.uid || stat.gid !== targetOwner.gid)) {
        fs.chownSync(target, targetOwner.uid, targetOwner.gid);
      }
    }
    fsyncDirectory(tempDir);
    fs.renameSync(tempDir, this.runDir(id));
    fsyncDirectory(this.runsDir);
    this.projections.delete(id);
    const replayed = this.getRun(id);
    const replayDigest = projectionDigest(replayed);
    if (replayDigest !== digest || stableStringify(comparableProjection(replayed)) !== stableStringify(comparableProjection(run))) {
      throw new Error(`Converted v2 projection failed equivalence verification for ${id}`);
    }
    this.upsertSummary(replayed);
    const indexStat = fs.statSync(this.indexPath);
    if (targetOwner.uid >= 0 && (indexStat.uid !== targetOwner.uid || indexStat.gid !== targetOwner.gid)) {
      fs.chownSync(this.indexPath, targetOwner.uid, targetOwner.gid);
    }
    return { ...report, dryRun: false, convertedAt, replayProjectionSha256: replayDigest, equivalent: true };
  }

  close(runId = null) {
    const projections = runId ? [this.projections.get(sanitizeRunId(runId))] : Array.from(this.projections.values());
    for (const projection of projections) {
      if (projection?.eventFd !== null && projection?.eventFd !== undefined) {
        fs.closeSync(projection.eventFd);
        projection.eventFd = null;
      }
    }
  }
}

module.exports = {
  CatalogRunStore,
  RUN_STATUSES,
  RESUMABLE_STATUSES,
  createRunId,
  sanitizeError,
  projectionDigest,
  conversionProjectionDigest,
  atomicWriteJson,
};
