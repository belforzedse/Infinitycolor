"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./runStore");

function canonicalSourceUrl(rawUrl) {
  const parsed = new URL(String(rawUrl));
  parsed.hash = "";
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
    parsed.port = "";
  }
  return parsed.toString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class MediaMappingStore {
  constructor(dir, opts = {}) {
    this.dir = path.join(dir, opts.directoryName || "catalog-media-mappings-v2");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.eventsPath = path.join(this.dir, "events.ndjson");
    this.legacyPath = path.join(dir, opts.legacyFileName || "catalog-media-mappings.json");
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.compactEvents = opts.compactEvents || 10_000;
    this.compactBytes = opts.compactBytes || 64 * 1024 * 1024;
    this.data = { media: {} };
    this.sequence = 0;
    this.eventsSinceSnapshot = 0;
    this.journalBytes = 0;
    this.fd = null;
    this.initialized = false;
    this.metrics = { appendCount: 0, appendBytes: 0, syncCount: 0, compactionCount: 0 };
    this.load();
  }

  load() {
    if (!fs.existsSync(this.snapshotPath)) {
      if (fs.existsSync(this.legacyPath)) {
        const legacyBytes = fs.readFileSync(this.legacyPath);
        const legacy = JSON.parse(legacyBytes.toString("utf8"));
        this.data = legacy && typeof legacy === "object" ? legacy : { media: {} };
        if (!this.data.media) this.data.media = {};
        this.legacyMetadata = { sha256: sha256(legacyBytes), bytes: legacyBytes.length };
      }
      return;
    }
    const snapshot = JSON.parse(fs.readFileSync(this.snapshotPath, "utf8"));
    if (snapshot.version !== 2 || !Number.isSafeInteger(snapshot.sequence) || !snapshot.data) {
      throw new Error("Invalid media mapping snapshot");
    }
    this.data = snapshot.data;
    if (!this.data.media) this.data.media = {};
    this.sequence = snapshot.sequence;
    this.initialized = true;
    if (!fs.existsSync(this.eventsPath)) throw new Error("Media mapping journal is missing");
    const bytes = fs.readFileSync(this.eventsPath);
    this.journalBytes = bytes.length;
    if (bytes.length === 0) return;
    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    const finalNewline = text.endsWith("\n");
    const last = finalNewline ? lines.length - 2 : lines.length - 1;
    let expected = this.sequence + 1;
    for (let index = 0; index <= last; index += 1) {
      const line = lines[index];
      if (!line) throw new Error(`Empty media mapping record at line ${index + 1}`);
      let event;
      try { event = JSON.parse(line); } catch (error) {
        if (index === last && !finalNewline) break;
        throw new Error(`Corrupt media mapping record at line ${index + 1}: ${error.message}`);
      }
      if (event.version !== 2 || event.sequence !== expected || event.operation !== "set") {
        throw new Error(`Invalid media mapping sequence at line ${index + 1}: expected ${expected}`);
      }
      this.data.media[event.key] = event.value;
      this.sequence = event.sequence;
      this.eventsSinceSnapshot += 1;
      expected += 1;
    }
  }

  initialize() {
    if (this.initialized) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    atomicWriteJson(this.snapshotPath, {
      version: 2,
      sequence: 0,
      createdAt: new Date().toISOString(),
      ...(this.legacyMetadata ? { legacy: this.legacyMetadata } : {}),
      data: this.data,
    });
    this.fd = fs.openSync(this.eventsPath, "ax", 0o600);
    fs.fsyncSync(this.fd);
    this.initialized = true;
  }

  get(type, key) {
    if (type !== "media") return null;
    let canonical;
    try { canonical = canonicalSourceUrl(key); } catch { canonical = String(key); }
    return this.data.media[canonical] || this.data.media[String(key)] || null;
  }

  getStrapiId(type, key) {
    return this.get(type, key)?.strapiId ?? null;
  }

  has(type, key) {
    return Boolean(this.get(type, key));
  }

  set(type, key, strapiId, meta = {}) {
    if (type !== "media") throw new Error(`Unsupported media mapping type: ${type}`);
    const canonical = canonicalSourceUrl(key);
    const value = { strapiId, updatedAt: new Date().toISOString(), ...meta };
    this.initialize();
    if (this.fd === null) this.fd = fs.openSync(this.eventsPath, "a", 0o600);
    const event = {
      version: 2,
      sequence: this.sequence + 1,
      operation: "set",
      key: canonical,
      sourceHash: sha256(canonical),
      value,
      timestamp: new Date().toISOString(),
    };
    const encoded = `${JSON.stringify(event)}\n`;
    fs.writeSync(this.fd, encoded, null, "utf8");
    this.data.media[canonical] = value;
    this.sequence = event.sequence;
    this.eventsSinceSnapshot += 1;
    this.journalBytes += Buffer.byteLength(encoded);
    this.metrics.appendCount += 1;
    this.metrics.appendBytes += Buffer.byteLength(encoded);
    return value;
  }

  all(type) {
    return type === "media" ? this.data.media : {};
  }

  size(type) {
    return Object.keys(this.all(type)).length;
  }

  syncBoundary() {
    if (!this.initialized) return;
    if (this.fd === null) this.fd = fs.openSync(this.eventsPath, "a", 0o600);
    fs.fdatasyncSync(this.fd);
    this.metrics.syncCount += 1;
    if (this.eventsSinceSnapshot >= this.compactEvents || this.journalBytes >= this.compactBytes) this.compact();
  }

  flush() {
    this.syncBoundary();
  }

  compact() {
    if (!this.initialized || this.eventsSinceSnapshot === 0) return;
    this.syncBoundaryWithoutCompaction();
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    atomicWriteJson(this.snapshotPath, {
      version: 2,
      sequence: this.sequence,
      compactedAt: new Date().toISOString(),
      ...(this.legacyMetadata ? { legacy: this.legacyMetadata } : {}),
      data: this.data,
    });
    const tmp = `${this.eventsPath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, this.eventsPath);
    this.eventsSinceSnapshot = 0;
    this.journalBytes = 0;
    this.metrics.compactionCount += 1;
  }

  syncBoundaryWithoutCompaction() {
    if (this.fd === null) this.fd = fs.openSync(this.eventsPath, "a", 0o600);
    fs.fdatasyncSync(this.fd);
    this.metrics.syncCount += 1;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

module.exports = { MediaMappingStore, canonicalSourceUrl, sha256 };
