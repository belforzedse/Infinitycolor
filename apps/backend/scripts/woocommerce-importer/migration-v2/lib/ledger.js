"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function safeRunId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

class RunLedger {
  constructor(stateDir, command, requestedRunId) {
    this.stateDir = path.resolve(stateDir);
    this.command = command;
    this.runId = requestedRunId || safeRunId(command);
    this.runDir = path.join(this.stateDir, "runs", this.runId);
    this.lockPath = path.join(this.stateDir, "runner.lock");
    this.summaryPath = path.join(this.runDir, "summary.json");
    this.eventsPath = path.join(this.runDir, "events.ndjson");
    this.startedAt = new Date().toISOString();
    this.lockFd = null;
    this.summary = {
      runId: this.runId,
      command,
      status: "running",
      startedAt: this.startedAt,
      updatedAt: this.startedAt,
      entities: {},
      failures: [],
      checkpoints: {},
      candidates: {},
      metrics: {},
    };
  }

  acquireLock() {
    if (fs.existsSync(this.lockPath)) {
      try {
        const holder = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
        const pid = Number(holder.pid);
        if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0);
        throw new Error(`Another migration runner holds ${this.lockPath}`);
      } catch (error) {
        if (error?.code !== "ESRCH" && !String(error?.message || "").includes("Unexpected")) throw error;
        fs.unlinkSync(this.lockPath);
      }
    }
    this.lockFd = fs.openSync(this.lockPath, "wx", 0o600);
    fs.writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, runId: this.runId, startedAt: this.startedAt }));
  }

  start() {
    fs.mkdirSync(path.join(this.stateDir, "runs"), { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stateDir, 0o700);
    fs.mkdirSync(this.runDir, { recursive: false, mode: 0o700 });
    try {
      this.acquireLock();
    } catch (error) {
      throw new Error(`Another migration runner holds ${this.lockPath}`);
    }
    this.persist();
    this.event("run-start", { command: this.command });
    return this;
  }

  static resume(stateDir, runId) {
    const summary = loadRun(stateDir, runId);
    if (!["failed", "paused", "running", "completed-with-exceptions"].includes(summary.status)) {
      throw new Error(`Run ${runId} is not resumable from status ${summary.status}`);
    }
    const ledger = new RunLedger(stateDir, summary.command, runId);
    const previousStatus = summary.status;
    ledger.summary = summary;
    ledger.startedAt = summary.startedAt;
    ledger.summary.status = "running";
    ledger.summary.resumedAt = new Date().toISOString();
    ledger.acquireLock();
    ledger.event("run-resume", { previousStatus });
    ledger.persist();
    return ledger;
  }

  event(type, detail = {}) {
    const record = { at: new Date().toISOString(), type, ...detail };
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.summary.updatedAt = record.at;
  }

  count(entity, outcome, amount = 1) {
    this.summary.entities[entity] ||= {
      source: 0,
      eligible: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      verified: 0,
    };
    this.summary.entities[entity][outcome] =
      Number(this.summary.entities[entity][outcome] || 0) + amount;
  }

  failure(entity, sourceId, code) {
    this.count(entity, "failed");
    this.issue(entity, sourceId, code);
  }

  issue(entity, sourceId, code) {
    if (this.summary.failures.length < 1000) {
      this.summary.failures.push({ entity, sourceId: String(sourceId || ""), code: String(code || "UNKNOWN") });
    }
  }

  checkpoint(entity, value) {
    this.summary.checkpoints[entity] = value;
    this.event("checkpoint", { entity, value });
    this.persist();
  }

  candidate(kind, sourceId) {
    this.summary.candidates[kind] ||= [];
    const value = String(sourceId);
    if (!this.summary.candidates[kind].includes(value)) this.summary.candidates[kind].push(value);
  }

  persist() {
    this.summary.updatedAt = new Date().toISOString();
    atomicJson(this.summaryPath, this.summary);
  }

  finish(status, extra = {}) {
    Object.assign(this.summary, extra, {
      status,
      finishedAt: new Date().toISOString(),
    });
    this.event("run-finish", { status });
    this.persist();
    this.release();
  }

  release() {
    if (this.lockFd !== null) {
      try { fs.closeSync(this.lockFd); } catch {}
      this.lockFd = null;
      try { fs.unlinkSync(this.lockPath); } catch {}
    }
  }
}

function loadRun(stateDir, runId) {
  const filePath = path.join(path.resolve(stateDir), "runs", runId, "summary.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

module.exports = { RunLedger, loadRun, atomicJson };
