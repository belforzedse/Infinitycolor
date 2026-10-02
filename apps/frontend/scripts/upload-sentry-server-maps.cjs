const { createRequire } = require("node:module");
const { resolve } = require("node:path");

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
      resolve(cwd, ".next/server"),
    ],
    "rejectOnError",
  );
  return true;
}

module.exports = { uploadServerSourceMaps };

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
