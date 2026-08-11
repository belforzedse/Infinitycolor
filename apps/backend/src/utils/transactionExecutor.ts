import type { Strapi } from "@strapi/strapi";

/**
 * Resolves the executor that raw SQL must run on.
 *
 * `strapi.db.query(...)` picks the surrounding transaction up automatically:
 * `@strapi/database` 4.25.21 keeps it in an `AsyncLocalStorage` and calls
 * `qb.transacting(...)` for every query builder it executes. `strapi.db.connection.raw`
 * does NOT — it goes straight to the pool. So a raw statement issued inside
 * `strapi.db.transaction(...)` without an explicit `trx` commits immediately and
 * survives a later rollback of the surrounding operation.
 *
 * Callers should still thread `trx` explicitly where they have it; this resolver is
 * the safety net that keeps a missed hand-off from silently escaping the transaction.
 */
export const resolveRawExecutor = async (strapi: Strapi, trx?: any): Promise<any> => {
  if (trx?.raw) return trx;

  const db: any = (strapi as any)?.db;
  try {
    // `inTransaction()` reads the ambient AsyncLocalStorage context. Calling
    // `transaction()` without a callback while one is already open returns a handle
    // onto that same transaction (its commit/rollback are no-ops) instead of opening
    // a nested one, so this never takes a second connection.
    if (typeof db?.inTransaction === "function" && db.inTransaction()) {
      const ambient = await db.transaction();
      const executor = typeof ambient?.get === "function" ? ambient.get() : null;
      if (executor?.raw) return executor;
    }
  } catch {
    // Fall through to the base connection: an unavailable ambient context is not a
    // reason to fail the caller's statement.
  }

  return db.connection;
};

/** Runs raw SQL on the correct executor for the current transaction context. */
export const runRawSql = async (
  strapi: Strapi,
  sql: string,
  bindings: any[],
  trx?: any,
): Promise<any> => {
  const executor = await resolveRawExecutor(strapi, trx);
  return executor.raw(sql, bindings);
};
