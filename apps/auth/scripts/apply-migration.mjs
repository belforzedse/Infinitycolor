import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const migrationUrl = process.env.AUTH_MIGRATION_DATABASE_URL?.trim();
const rolePassword = process.env.AUTH_DATABASE_ROLE_PASSWORD?.trim();

if (
  !migrationUrl &&
  (!process.env.PGHOST || !process.env.PGUSER || !process.env.PGDATABASE)
) {
  throw new Error(
    "AUTH_MIGRATION_DATABASE_URL or PGHOST, PGUSER, and PGDATABASE are required",
  );
}
if (!rolePassword || rolePassword.length < 32) {
  throw new Error(
    "AUTH_DATABASE_ROLE_PASSWORD must contain at least 32 characters",
  );
}

const expectedRelations = [
  "users",
  "sessions",
  "accounts",
  "verifications",
  "jwks",
  "strapi_identity_links",
  "return_grants",
];
const migrationPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../migrations/0001_better_auth.sql",
);
const migration = await fs.readFile(migrationPath, "utf8");
const auditMigration = await fs.readFile(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../migrations/0002_audit_outbox.sql"),
  "utf8",
);
const client = new Client({
  ...(migrationUrl ? { connectionString: migrationUrl } : {}),
  application_name: "infinity-auth-migration",
});

await client.connect();
try {
  await client.query("select pg_advisory_lock($1::bigint)", [914_882_046]);
  const status = await client.query(
    `select relname, to_regclass('auth.' || relname) is not null as present
       from unnest($1::text[]) as relname`,
    [expectedRelations],
  );
  const present = status.rows.filter((row) => row.present).length;
  if (present !== 0 && present !== expectedRelations.length) {
    throw new Error("AUTH_MIGRATION_PARTIAL_SCHEMA");
  }
  if (present === 0) {
    await client.query(migration);
  }
  await client.query(auditMigration);

  const statement = await client.query(
    "select format('alter role %I password %L', 'infinity_auth_app', $1::text) as sql",
    [rolePassword],
  );
  await client.query(statement.rows[0].sql);
  console.log(
    present === 0
      ? "auth migrations applied"
      : "auth migrations verified and additive migrations applied",
  );
} finally {
  await client
    .query("select pg_advisory_unlock($1::bigint)", [914_882_046])
    .catch(() => {});
  await client.end();
}
