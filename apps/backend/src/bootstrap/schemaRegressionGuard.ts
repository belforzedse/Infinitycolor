import type { Strapi } from "@strapi/strapi";

/**
 * Refuse to run Strapi's schema sync when the running build declares fewer
 * columns than the database already has persisted.
 *
 * On 2026-08-29 a Strapi process running an older backend image synced against
 * production with the default `forceMigration: true`. Every column the newer
 * migrations had added was classified as "removed" and dropped, and the older
 * shape was persisted to `strapi_database_schema`. The missing
 * `orders.analytics_correlation_id` then broke storefront checkout outright,
 * and nothing self-healed: the migration ledger still recorded the migrations
 * as applied, and `sync()` short-circuits on the persisted schema hash without
 * ever inspecting the real database.
 *
 * A stale image booting against a newer database is always a deployment
 * mistake, so failing closed is correct. Set
 * `ALLOW_SCHEMA_COLUMN_REMOVAL=true` for the one case where it is not: a
 * release that deliberately drops a column.
 */

const SCHEMA_TABLE = "strapi_database_schema";
const ESCAPE_HATCH = "ALLOW_SCHEMA_COLUMN_REMOVAL";

type PersistedSchema = { tables?: Array<{ name?: string; columns?: Array<{ name?: string }> }> };

export const collectDeclaredColumns = (metadata: any): Map<string, Set<string>> => {
  const declared = new Map<string, Set<string>>();
  for (const meta of metadata.values()) {
    const tableName = meta?.tableName;
    if (!tableName) continue;
    const columns = declared.get(tableName) ?? new Set<string>();
    for (const attribute of Object.values<any>(meta.attributes ?? {})) {
      if (attribute?.columnName) columns.add(attribute.columnName);
    }
    declared.set(tableName, columns);
  }
  return declared;
};

export const findColumnRegressions = (
  persisted: PersistedSchema,
  declared: Map<string, Set<string>>,
): string[] => {
  const regressions: string[] = [];
  for (const table of persisted.tables ?? []) {
    if (!table?.name) continue;
    const declaredColumns = declared.get(table.name);
    // The persisted schema is derived from content-type metadata, so it never
    // contains hand-written custom tables (those are protected separately, via
    // `core_persisted_tables`). A table in here that the running build does not
    // declare therefore means a content type this build predates — and
    // `forceMigration` drops the whole table, which is worse than losing one
    // column. Flag it the same way.
    if (!declaredColumns) {
      regressions.push(`${table.name} (whole table)`);
      continue;
    }
    for (const column of table.columns ?? []) {
      if (column?.name && !declaredColumns.has(column.name)) {
        regressions.push(`${table.name}.${column.name}`);
      }
    }
  }
  return regressions.sort();
};

export const registerSchemaRegressionGuard = (strapi: Strapi) => {
  (strapi as any).hook("strapi::content-types.beforeSync").register(async () => {
    if (String(process.env[ESCAPE_HATCH] || "").toLowerCase() === "true") {
      strapi.log.warn(`${ESCAPE_HATCH}=true — skipping the schema regression guard.`);
      return;
    }

    const connection = (strapi as any).db.getSchemaConnection();
    if (!(await connection.hasTable(SCHEMA_TABLE))) return;

    const row = await (strapi as any).db
      .getConnection()
      .select("schema")
      .from(SCHEMA_TABLE)
      .orderBy("time", "DESC")
      .first();
    if (!row?.schema) return;

    const persisted: PersistedSchema =
      typeof row.schema === "object" ? row.schema : JSON.parse(row.schema);

    const regressions = findColumnRegressions(
      persisted,
      collectDeclaredColumns((strapi as any).db.metadata),
    );
    if (regressions.length === 0) return;

    strapi.log.error(
      "Refusing to sync: this build declares fewer columns than the database has persisted. " +
        "This is what a stale image does to a newer database, and syncing would drop them.",
      { missing: regressions, escapeHatch: `${ESCAPE_HATCH}=true` },
    );
    throw new Error(
      `Schema regression: ${regressions.length} persisted column(s) are not declared by this build ` +
        `(${regressions.slice(0, 5).join(", ")}${regressions.length > 5 ? ", …" : ""}). ` +
        `Deploy the correct image, or set ${ESCAPE_HATCH}=true if the removal is intended.`,
    );
  });
};
