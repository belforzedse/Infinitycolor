/**
 * Shared env constants for the backend integration test layer.
 *
 * The integration layer boots a REAL Strapi against a REAL, disposable
 * Postgres (same engine as production). These constants are the single
 * source of truth for the temp file used to hand the DB connection from
 * Jest's `globalSetup` (parent process) to the test files. We cannot share
 * a JS object across that boundary, and Jest sandboxes each test file's
 * `global`, so a temp file + `process.env` is the reliable channel.
 */
import os from "os";
import path from "path";

/** Postgres image. Defaults to the Arvan mirror (matches CI's `docker.arvancloud.ir/node:20`). */
export const PG_IMAGE =
  process.env.INTEGRATION_PG_IMAGE || "docker.arvancloud.ir/postgres:16-alpine";

/** `testcontainers` (default) launches a disposable container; `service` reuses CI-provided env. */
export const DB_MODE = (process.env.INTEGRATION_DB_MODE || "testcontainers").toLowerCase();

/** Path used to pass DB connection details from globalSetup to the test files. */
export const CONN_FILE = path.join(os.tmpdir(), "infinity-int-db.json");

export type IntegrationDbConnection = {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
};
