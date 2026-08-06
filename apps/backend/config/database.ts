import path from "path";

export default ({ env }) => {
  const client = env("DATABASE_CLIENT", "postgres");

  const connections = {
    mysql: {
      connection: {
        connectionString: env("DATABASE_URL"),
        host: env("DATABASE_HOST", "localhost"),
        port: env.int("DATABASE_PORT", 3306),
        database: env("DATABASE_NAME", "strapi"),
        user: env("DATABASE_USERNAME", "strapi"),
        password: env("DATABASE_PASSWORD", "strapi"),
        ssl: env.bool("DATABASE_SSL", false) && {
          key: env("DATABASE_SSL_KEY", undefined),
          cert: env("DATABASE_SSL_CERT", undefined),
          ca: env("DATABASE_SSL_CA", undefined),
          capath: env("DATABASE_SSL_CAPATH", undefined),
          cipher: env("DATABASE_SSL_CIPHER", undefined),
          rejectUnauthorized: env.bool(
            "DATABASE_SSL_REJECT_UNAUTHORIZED",
            true
          ),
        },
      },
      pool: {
        min: env.int("DATABASE_POOL_MIN", 2),
        // Increased from 10 to 25 per instance to prevent connection starvation
        // With 4 Strapi instances, this allows 100 total connections
        // Ensure database max_connections can handle this (increase to 150+)
        max: env.int("DATABASE_POOL_MAX", 25),
      },
    },
    mysql2: {
      connection: {
        host: env("DATABASE_HOST", "localhost"),
        port: env.int("DATABASE_PORT", 3306),
        database: env("DATABASE_NAME", "strapi"),
        user: env("DATABASE_USERNAME", "strapi"),
        password: env("DATABASE_PASSWORD", "strapi"),
        ssl: env.bool("DATABASE_SSL", false) && {
          key: env("DATABASE_SSL_KEY", undefined),
          cert: env("DATABASE_SSL_CERT", undefined),
          ca: env("DATABASE_SSL_CA", undefined),
          capath: env("DATABASE_SSL_CAPATH", undefined),
          cipher: env("DATABASE_SSL_CIPHER", undefined),
          rejectUnauthorized: env.bool(
            "DATABASE_SSL_REJECT_UNAUTHORIZED",
            true
          ),
        },
      },
      pool: {
        min: env.int("DATABASE_POOL_MIN", 2),
        // Increased from 10 to 25 per instance to prevent connection starvation
        // With 4 Strapi instances, this allows 100 total connections
        // Ensure database max_connections can handle this (increase to 150+)
        max: env.int("DATABASE_POOL_MAX", 25),
      },
    },
    postgres: {
      connection: {
        connectionString: env("DATABASE_URL"),
        host: env("DATABASE_HOST", "localhost"),
        port: env.int("DATABASE_PORT", 5432),
        database: env("DATABASE_NAME", "strapi"),
        user: env("DATABASE_USERNAME", "strapi"),
        password: env("DATABASE_PASSWORD", "strapi"),
        ssl: env.bool("DATABASE_SSL", false) && {
          key: env("DATABASE_SSL_KEY", undefined),
          cert: env("DATABASE_SSL_CERT", undefined),
          ca: env("DATABASE_SSL_CA", undefined),
          capath: env("DATABASE_SSL_CAPATH", undefined),
          cipher: env("DATABASE_SSL_CIPHER", undefined),
          rejectUnauthorized: env.bool(
            "DATABASE_SSL_REJECT_UNAUTHORIZED",
            true
          ),
        },
        schema: env("DATABASE_SCHEMA", "public"),
      },
      pool: {
        min: env.int("DATABASE_POOL_MIN", 2),
        // Increased from 10 to 25 per instance to prevent connection starvation
        // With 4 Strapi instances, this allows 100 total connections
        // Ensure PostgreSQL max_connections can handle this (increase to 150+)
        max: env.int("DATABASE_POOL_MAX", 25),
      },
    },
    sqlite: {
      connection: {
        filename: path.join(
          __dirname,
          "..",
          "..",
          env("DATABASE_FILENAME", ".tmp/data.db")
        ),
      },
      useNullAsDefault: true,
    },
  };

  return {
    connection: {
      client,
      ...connections[client],
      acquireConnectionTimeout: env.int("DATABASE_CONNECTION_TIMEOUT", 60000),
    },
    settings: {
      // @strapi/database defaults this to `true`. On EVERY boot, after custom
      // migrations run, Strapi diffs the real DB schema against its own
      // content-type schema and — because this defaults true — DROPS any table
      // it doesn't recognize as a content-type table. Any table created by a
      // hand-written migration in database/migrations/*.js (not a Strapi
      // content-type) is invisible to that diff and gets silently deleted on
      // the very next boot, even though `strapi_migrations` still records the
      // migration as applied. This is the exact mechanism behind the
      // "Concurrent migrations across instances" issue documented in
      // CLAUDE.md ("this silently dropped background_job_locks in prod/staging
      // and disabled the stock expiry jobs") — it is not actually about
      // instance races; it reproduces deterministically on a single instance's
      // very first boot, confirmed against @strapi/database 4.25.21's
      // dist/index.js (createSchemaDiff/diffSchemas + schema.updateSchema).
      // Disabling it only stops Strapi from auto-DROPPING tables/columns it
      // doesn't recognize; it does not stop it from CREATING new content-type
      // tables or applying column/index/FK changes to existing ones (that path
      // — schema.builder.alterTable — is unconditional). Schema removal in this
      // project is handled explicitly via database/migrations/*.js.
      forceMigration: false,
    },
  };
};
