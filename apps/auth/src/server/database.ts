import { Pool } from "pg";
import * as Sentry from "@sentry/nextjs";
import { getAuthEnv } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __infinityAuthPool: Pool | undefined;
}

export function getAuthPool(): Pool {
  if (globalThis.__infinityAuthPool) return globalThis.__infinityAuthPool;
  const env = getAuthEnv();
  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    options: "-c search_path=auth,public",
    application_name: "infinity-auth",
  });
  pool.on("error", (error) => {
    const reasonCode =
      (error as Error & { code?: string }).code ?? "POOL_ERROR";
    console.error(
      JSON.stringify({ event: "auth_database_pool_error", reasonCode }),
    );
    Sentry.captureException(error, { tags: { reasonCode } });
  });
  if (env.nodeEnv !== "production") globalThis.__infinityAuthPool = pool;
  return pool;
}

export async function checkAuthDatabase(): Promise<void> {
  await getAuthPool().query("select 1 as ready");
}
