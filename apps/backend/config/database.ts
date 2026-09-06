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
      // Strapi defaults this to true, which makes schema sync destructive: any
      // column, index or table the running build does not declare is dropped.
      // Keep the default, but make it switchable so a one-shot repair boot can
      // run additively (`dropColumn`/`dropIndex`/`dropTable` all become no-ops).
      // Do NOT leave it false permanently — sync then skips dropping a changed
      // index but still tries to recreate it, which aborts startup.
      forceMigration: env.bool("DATABASE_FORCE_MIGRATION", true),
    },
  };
};
