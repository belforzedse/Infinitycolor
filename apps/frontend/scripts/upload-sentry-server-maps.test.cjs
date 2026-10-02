const test = require("node:test");
const assert = require("node:assert/strict");
const { uploadServerSourceMaps } = require("./upload-sentry-server-maps.cjs");

test("disabled local builds do not acquire a CLI or credential", async () => {
  assert.equal(
    await uploadServerSourceMaps({
      env: {},
      createCli: () => {
        throw new Error("unexpected upload");
      },
    }),
    false,
  );
});

test("enabled builds require both the secret and exact release", async () => {
  for (const env of [
    { SENTRY_UPLOAD_ENABLED: "true" },
    { SENTRY_UPLOAD_ENABLED: "true", SENTRY_AUTH_TOKEN: "test-secret" },
  ]) {
    await assert.rejects(uploadServerSourceMaps({ env }), /requires its build secret and release/);
  }
});

test("server artifacts use matching IDs, await processing, and keep secrets out of arguments", async () => {
  let call;
  assert.equal(
    await uploadServerSourceMaps({
      cwd: "/build/storefront",
      env: {
        SENTRY_UPLOAD_ENABLED: "true",
        SENTRY_AUTH_TOKEN: "test-secret",
        GITHUB_SHA: "exact-release",
      },
      createCli: (options) => ({
        execute: async (args, mode) => {
          call = { options, args, mode };
        },
      }),
    }),
    true,
  );
  assert.equal(call.options.authToken, "test-secret");
  assert.equal(call.args.includes("test-secret"), false);
  assert.equal(call.args.at(-1), "/build/storefront/.next/server");
  assert.equal(call.args[call.args.indexOf("--release") + 1], "exact-release");
  for (const flag of ["--no-rewrite", "--validate", "--strict", "--wait-for"])
    assert.ok(call.args.includes(flag));
  assert.equal(call.mode, "rejectOnError");
});

test("upload and processing failure block the build", async () => {
  const failure = new Error("unavailable upload");
  await assert.rejects(
    uploadServerSourceMaps({
      env: {
        SENTRY_UPLOAD_ENABLED: "true",
        SENTRY_AUTH_TOKEN: "test-secret",
        GITHUB_SHA: "exact-release",
      },
      createCli: () => ({
        execute: async () => {
          throw failure;
        },
      }),
    }),
    (error) => error === failure,
  );
});
