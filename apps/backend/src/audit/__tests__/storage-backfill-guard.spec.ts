/**
 * Guards against reintroducing the audit demotion bug:
 * wiped modern columns must not be backfilled as schema_version=1 / legacy.activity
 * when the row still carries a canonical catalog title.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_EVENT_CATALOG } from "../catalog";

const MIGRATIONS = join(__dirname, "../../../database/migrations");
const REBUILD = join(MIGRATIONS, "2026.08.11T15.00.00.rebuild-admin-audit-events.js");
const REPAIR = join(MIGRATIONS, "2026.09.11T02.00.00.repair-demoted-audit-schema-version.js");

const migration = require(REBUILD);
const repairMigration = require(REPAIR);
const {
  CATALOG_TITLE_TO_EVENT_KEY,
  CATALOG_KEY_TO_DOMAIN_OPERATION,
  FREEFORM_TITLE_RULES,
  EXACT_TITLE_RULES,
  catalogTitleCaseSql,
  inferredEventKeyOrNullSql,
} = migration.__private;

describe("audit storage backfill demotion guard", () => {
  it("maps catalog titles instead of defaulting every null row to legacy v1", () => {
    expect(CATALOG_TITLE_TO_EVENT_KEY["ورود موفق"]).toBe("authentication.login_succeeded");
    expect(CATALOG_TITLE_TO_EVENT_KEY["نقش مدیر تغییر کرد"]).toBe("administrators.role_changed");

    const sql = catalogTitleCaseSql();
    expect(sql).toContain("WHEN title = 'ورود موفق' THEN 'authentication.login_succeeded'");
    expect(sql).toContain("ELSE 'legacy.activity'");

    const source = readFileSync(REBUILD, "utf8");
    // Must not unconditionally COALESCE(schema_version, 1) for all null rows.
    expect(source).not.toMatch(/schema_version = COALESCE\(schema_version, 1\)/);
    expect(source).toContain("CASE WHEN ${inferredIsModern} THEN 2 ELSE 1 END");
  });

  it("exposes a forward repair migration for already-demoted rows", () => {
    expect(typeof repairMigration.up).toBe("function");
    const source = readFileSync(REPAIR, "utf8");
    expect(source).toContain("event_key = 'legacy.activity'");
    expect(source).toContain("schema_version = 2");
  });

  // The repair and the backfill must never disagree: if they did, a schema-sync
  // wipe would re-demote exactly the rows the repair had just promoted.
  it("infers event keys from one shared table shared by both migrations", () => {
    expect(repairMigration.__private.catalogTitleCaseSql()).toBe(inferredEventKeyOrNullSql());
    expect(catalogTitleCaseSql()).toContain(
      "WHEN title LIKE 'ورژن%' THEN 'products.updated'",
    );
  });

  // A typo'd key would file real events under a key the activity report cannot filter.
  it("only ever infers event keys that exist in the audit catalog", () => {
    const known = new Set(Object.keys(AUDIT_EVENT_CATALOG));
    const inferred = [
      ...Object.values(CATALOG_TITLE_TO_EVENT_KEY as Record<string, string>),
      ...FREEFORM_TITLE_RULES.map(([, key]: [string, string]) => key),
      ...EXACT_TITLE_RULES.map(([, key]: [string, string]) => key),
    ];
    expect(inferred.length).toBeGreaterThan(0);
    expect(inferred.filter((key) => !known.has(key))).toEqual([]);
  });

  // A promoted row whose domain/operation disagrees with the writer splits the
  // activity report's domain filter across two values for the same event.
  it("stamps promoted rows with the same domain/operation the writer emits", () => {
    const drifted = Object.entries(AUDIT_EVENT_CATALOG as Record<string, any>)
      .filter(([key, definition]) => {
        const pair = (CATALOG_KEY_TO_DOMAIN_OPERATION as Record<string, [string, string]>)[key];
        return !pair || pair[0] !== definition.domain || pair[1] !== definition.operation;
      })
      .map(([key]) => key);
    expect(drifted).toEqual([]);
  });

  // Catalog wording is the join key, so drift silently stops promoting live events.
  it("keeps the catalog title table in sync with the audit catalog", () => {
    const drifted = Object.entries(CATALOG_TITLE_TO_EVENT_KEY as Record<string, string>)
      .filter(([title, key]) => {
        const definition = (AUDIT_EVENT_CATALOG as Record<string, any>)[key];
        return !definition || (definition.titleFa !== title && definition.titleEn !== title);
      })
      .map(([title, key]) => `${key}: ${title}`);
    expect(drifted).toEqual([]);
  });
});
