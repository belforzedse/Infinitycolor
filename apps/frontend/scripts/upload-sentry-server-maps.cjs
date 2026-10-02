const { createRequire } = require("node:module");
const { resolve, join, relative, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const {
  readdirSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} = require("node:fs");

// The public upload proxy accepts 20 MiB while Sentry advertises 32 MiB.
// Bound uncompressed inputs below that limit, including room for the bundle.
const MAX_BATCH_BYTES = 12 * 1024 * 1024;

function serverMapBatches(directory, limit = MAX_BATCH_BYTES) {
  const pairs = [];
  function visit(current) {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(current, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.name.endsWith(".js.map") && existsSync(file.slice(0, -4))) {
        const source = file.slice(0, -4);
        const bytes = statSync(file).size + statSync(source).size;
        if (bytes > limit)
          throw new Error("A server source map pair exceeds the private upload batch limit.");
        pairs.push({ files: [source, file], bytes });
      }
    }
  }
  visit(directory);
  if (!pairs.length) throw new Error("No server source map pairs available for private upload.");
  const batches = [];
  for (const pair of pairs) {
    let batch = batches.at(-1);
    if (!batch || batch.bytes + pair.bytes > limit) {
      batch = { files: [], bytes: 0 };
      batches.push(batch);
    }
    batch.files.push(...pair.files);
    batch.bytes += pair.bytes;
  }
  return batches;
}

async function uploadServerSourceMaps({ env = process.env, cwd = process.cwd(), createCli } = {}) {
  if (env.SENTRY_UPLOAD_ENABLED !== "true") return false;
  if (!env.SENTRY_AUTH_TOKEN || !(env.SENTRY_RELEASE || env.GITHUB_SHA)) {
    throw new Error("Private server source map upload requires its build secret and release.");
  }

  // The SDK's automatic upload can recover from an upload error. Server maps
  // are required for this image, so upload them separately and fail the build
  // on any error. Reuse the injected IDs without modifying the emitted files.
  const makeCli =
    createCli ||
    ((options) => {
      const sdkRequire = createRequire(require.resolve("@sentry/nextjs", { paths: [cwd] }));
      const SentryCli = sdkRequire("@sentry/cli");
      return new SentryCli(null, options);
    });
  const cli = makeCli({
    authToken: env.SENTRY_AUTH_TOKEN,
    url: env.SENTRY_URL || "https://errors.alpagency.net",
    org: env.SENTRY_ORG || "alpagency",
    project: env.SENTRY_PROJECT || "infinitycolor-frontend",
  });
  const serverDirectory = resolve(cwd, ".next/server");
  const batches = serverMapBatches(serverDirectory);
  const scratch = mkdtempSync(join(tmpdir(), "sentry-private-server-maps-"));
  try {
    for (let index = 0; index < batches.length; index += 1) {
      const directory = join(scratch, String(index));
      for (const source of batches[index].files) {
        const target = join(directory, relative(serverDirectory, source));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
      await cli.execute(
        [
          "sourcemaps",
          "upload",
          "--release",
          env.SENTRY_RELEASE || env.GITHUB_SHA,
          "--no-rewrite",
          "--validate",
          "--strict",
          "--wait-for",
          "120",
          directory,
        ],
        "rejectOnError",
      );
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return true;
}

module.exports = { uploadServerSourceMaps, serverMapBatches };

if (require.main === module) {
  uploadServerSourceMaps()
    .then((uploaded) => {
      console.log(
        uploaded
          ? "Private server source map upload completed."
          : "Private server source map upload disabled.",
      );
    })
    .catch(() => {
      // Never serialize CLI options or the build credential into a build log.
      console.error("Private server source map upload failed; this image cannot be released.");
      process.exitCode = 1;
    });
}
