const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { uploadServerSourceMaps, serverMapBatches } = require("./upload-sentry-server-maps.cjs");

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "server-map-fixture-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const directory = join(cwd, ".next/server");
  mkdirSync(join(directory, "auth"), { recursive: true });
  for (const name of ["auth/callback.js", "catalog.js"]) {
    writeFileSync(join(directory, name), "original-script");
    writeFileSync(join(directory, name + ".map"), "original-map");
  }
  return { cwd, directory };
}

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

test("server artifacts use matching IDs, await processing, and keep secrets out of arguments", async (t) => {
  const { cwd } = fixture(t);
  let call;
  assert.equal(
    await uploadServerSourceMaps({
      cwd,
      env: {
        SENTRY_UPLOAD_ENABLED: "true",
        SENTRY_AUTH_TOKEN: "test-secret",
        GITHUB_SHA: "exact-release",
      },
      createCli: (options) => ({
        execute: async (args, mode) => {
          call = { options, args, mode };
          assert.equal(
            readFileSync(join(args.at(-1), "auth/callback.js"), "utf8"),
            "original-script",
          );
          assert.equal(
            readFileSync(join(args.at(-1), "auth/callback.js.map"), "utf8"),
            "original-map",
          );
        },
      }),
    }),
    true,
  );
  assert.equal(call.options.authToken, "test-secret");
  assert.equal(call.args.includes("test-secret"), false);
  assert.equal(existsSync(call.args.at(-1)), false);
  assert.equal(call.args[call.args.indexOf("--release") + 1], "exact-release");
  for (const flag of ["--no-rewrite", "--validate", "--strict", "--wait-for"])
    assert.ok(call.args.includes(flag));
  assert.equal(call.mode, "rejectOnError");
});

test("upload and processing failure block the build and clean temporary maps", async (t) => {
  const { cwd } = fixture(t);
  let uploadedDirectory;
  const failure = new Error("unavailable upload");
  await assert.rejects(
    uploadServerSourceMaps({
      cwd,
      env: {
        SENTRY_UPLOAD_ENABLED: "true",
        SENTRY_AUTH_TOKEN: "test-secret",
        GITHUB_SHA: "exact-release",
      },
      createCli: () => ({
        execute: async (args) => {
          uploadedDirectory = args.at(-1);
          throw failure;
        },
      }),
    }),
    (error) => error === failure,
  );
  assert.equal(existsSync(uploadedDirectory), false);
});

test("batches stay under the bound and never separate a script from its map", (t) => {
  const { directory } = fixture(t);
  const batches = serverMapBatches(directory, 40);
  assert.equal(batches.length, 2);
  for (const batch of batches) {
    assert.ok(batch.bytes <= 40);
    assert.equal(batch.files.length, 2);
    assert.equal(batch.files[1], batch.files[0] + ".map");
  }
  assert.throws(() => serverMapBatches(directory, 10), /exceeds/);
});

test("an empty upload cannot silently pass", (t) => {
  const { directory } = fixture(t);
  rmSync(join(directory, "catalog.js.map"));
  rmSync(join(directory, "auth/callback.js.map"));
  assert.throws(() => serverMapBatches(directory), /No server source map pairs/);
});
