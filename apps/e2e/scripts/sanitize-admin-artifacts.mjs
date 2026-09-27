import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".log", ".md", ".txt", ".xml"]);
const SENSITIVE_ENV_KEY = /(authorization|cookie|credential|email|jwt|national|password|phone|private.?key|secret|token)/i;
const SENSITIVE_JSON_KEY = /(authorization|cookie|credential|email|jwt|national|password|phone|private.?key|secret|storage.?state|token)/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configuredSecrets(environment = process.env) {
  return Object.entries(environment)
    .filter(([key, value]) => SENSITIVE_ENV_KEY.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value);
}

function stripUrlQuery(value) {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (candidate) => {
    try {
      const url = new URL(candidate);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return candidate;
    }
  });
}

export function sanitizeText(value, secretValues = configuredSecrets()) {
  let sanitized = value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/^((?:set-)?cookie|authorization)\s*:[^\r\n]*$/gim, "$1: [REDACTED]");
  for (const secret of secretValues) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  return stripUrlQuery(sanitized);
}

function scrubJson(value, secretValues) {
  if (Array.isArray(value)) return value.map((entry) => scrubJson(entry, secretValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_JSON_KEY.test(key) ? "[REDACTED]" : scrubJson(entry, secretValues),
      ]),
    );
  }
  return typeof value === "string" ? sanitizeText(value, secretValues) : value;
}

function sanitizeJsonLines(value, secretValues) {
  return value
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(scrubJson(JSON.parse(line), secretValues));
      } catch {
        return sanitizeText(line, secretValues);
      }
    })
    .join("\n");
}

function isImage(buffer) {
  return (
    (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP")
  );
}

const DEFLATE = { type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } };

/**
 * A sanitized copy of a zip, or null when there is nothing to change. Handles
 * a Playwright trace, and archives that carry traces inside them — a sharded
 * run's blob report stores each test's trace as a nested zip.
 */
async function sanitizeArchive(buffer, secretValues) {
  const archive = await JSZip.loadAsync(buffer);
  const names = Object.keys(archive.files);
  if (names.some((name) => name.endsWith("trace.trace") || name.endsWith("trace.network"))) {
    for (const name of names) {
      const entry = archive.files[name];
      if (entry.dir) continue;
      if (name.endsWith("trace.network")) {
        archive.remove(name);
        continue;
      }
      if (name.includes("/resources/") || name.startsWith("resources/")) {
        const content = await entry.async("nodebuffer");
        if (!isImage(content)) archive.remove(name);
        continue;
      }
      const content = await entry.async("string");
      archive.file(name, sanitizeJsonLines(content, secretValues));
    }
    return archive.generateAsync(DEFLATE);
  }

  let changed = false;
  for (const name of names) {
    const entry = archive.files[name];
    if (entry.dir) continue;
    if (name.toLowerCase().endsWith(".zip")) {
      const inner = await sanitizeArchive(await entry.async("nodebuffer"), secretValues);
      if (inner) {
        archive.file(name, inner);
        changed = true;
      }
    } else if (/\.(jsonl|json|md|txt|log)$/i.test(name)) {
      // Structure-preserving: only string contents change (queries, bearer
      // tokens, cookie lines, configured secret values).
      const content = await entry.async("string");
      const sanitized = sanitizeText(content, secretValues);
      if (sanitized !== content) {
        archive.file(name, sanitized);
        changed = true;
      }
    }
  }
  return changed ? archive.generateAsync(DEFLATE) : null;
}

async function sanitizeTraceArchive(filePath, secretValues) {
  const sanitized = await sanitizeArchive(await readFile(filePath), secretValues);
  if (sanitized) await writeFile(filePath, sanitized);
}

async function walk(root) {
  try {
    if (!(await stat(root)).isDirectory()) return [root];
  } catch {
    return [];
  }
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(resolved)));
    else if (entry.isFile()) files.push(resolved);
  }
  return files;
}

export async function sanitizeAdminArtifacts({ roots, authDir, secretValues = configuredSecrets() }) {
  if (authDir) await rm(authDir, { recursive: true, force: true });
  for (const root of roots) {
    for (const filePath of await walk(root)) {
      if (path.extname(filePath).toLowerCase() === ".zip") {
        await sanitizeTraceArchive(filePath, secretValues);
      } else if (TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        const original = await readFile(filePath, "utf8");
        await writeFile(filePath, sanitizeText(original, secretValues));
      }
    }
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const cwd = process.cwd();
  // Paths to sanitize may be given (the staging jobs pass theirs); the admin
  // smoke job relies on these defaults.
  const requested = process.argv.slice(2);
  const roots = requested.length
    ? requested.map((root) => path.resolve(cwd, root))
    : [
        path.join(cwd, "apps/e2e/e2e-admin-results.xml"),
        path.join(cwd, "apps/e2e/playwright-report/admin"),
        path.join(cwd, "apps/e2e/test-results/admin"),
      ];
  const authDir = path.join(cwd, "apps/e2e/.auth");
  try {
    await sanitizeAdminArtifacts({ roots, authDir });
    console.info("Sanitized Playwright artifacts and removed authentication state.");
  } catch {
    // Artifacts are collected even for failed jobs. If sanitization cannot be
    // proven, delete the exact diagnostic roots so raw credentials cannot be
    // uploaded by an `artifacts: when: always` policy.
    await Promise.all([...roots, authDir].map((target) => rm(target, { recursive: true, force: true })));
    console.error("Artifact sanitization failed; unsafe diagnostics were removed.");
    process.exitCode = 70;
  }
}
