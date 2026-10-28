/**
 * Trash retention policy: products left in Trash are permanently deleted
 * (tombstoned, see product-lifecycle.ts) after a configured number of days.
 *
 * `PRODUCT_TRASH_RETENTION_DAYS`
 *   unset / "" / "0"  → retention off (the default): nothing is ever swept
 *   1..3650           → days a product stays in Trash
 *   anything else     → treated as off and logged as a configuration error;
 *                       a malformed value must never delete anything.
 *
 * The clock starts at the later of the trash time and the moment retention was
 * first seen enabled (`enabledSince`, kept in the Strapi core store). Turning
 * retention on therefore never sweeps a backlog of old Trash at once: every
 * product already there gets the full period from that moment.
 */

export const TRASH_RETENTION_ENV = "PRODUCT_TRASH_RETENTION_DAYS";
export const MAX_TRASH_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const STORE = { type: "core", name: "product-trash-retention" } as const;
const ENABLED_SINCE_KEY = "enabledSince";

export type TrashRetentionConfig =
  | { enabled: true; days: number }
  | { enabled: false; reason: "disabled" }
  | { enabled: false; reason: "invalid"; raw: string };

export function readTrashRetentionConfig(env: NodeJS.ProcessEnv = process.env): TrashRetentionConfig {
  const raw = String(env[TRASH_RETENTION_ENV] ?? "").trim();
  if (raw === "" || raw === "0") return { enabled: false, reason: "disabled" };
  if (!/^\d+$/.test(raw)) return { enabled: false, reason: "invalid", raw };
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_TRASH_RETENTION_DAYS) {
    return { enabled: false, reason: "invalid", raw };
  }
  return { enabled: true, days };
}

/** Days shown to admins on the Trash page; 0 hides the notice. */
export function trashRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const config = readTrashRetentionConfig(env);
  return config.enabled ? config.days : 0;
}

function storeOf(strapi: any) {
  const factory = strapi?.store;
  return typeof factory === "function" ? factory(STORE) : null;
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function readRetentionEnabledSince(strapi: any): Promise<Date | null> {
  const store = storeOf(strapi);
  if (!store) return null;
  return parseDate(await store.get({ key: ENABLED_SINCE_KEY }));
}

/**
 * Records the first moment retention ran enabled. A future or unreadable
 * stored value is replaced by `now`, so it can only ever delay deletion.
 */
export async function ensureRetentionEnabledSince(strapi: any, now: Date): Promise<Date> {
  const store = storeOf(strapi);
  if (!store) return now;
  const existing = parseDate(await store.get({ key: ENABLED_SINCE_KEY }));
  if (existing && existing.getTime() <= now.getTime()) return existing;
  await store.set({ key: ENABLED_SINCE_KEY, value: now.toISOString() });
  return now;
}

/** When a trashed product becomes eligible for permanent deletion. */
export function purgeDueAt(removedAt: Date, enabledSince: Date | null, days: number): Date {
  const start = enabledSince && enabledSince.getTime() > removedAt.getTime() ? enabledSince : removedAt;
  return new Date(start.getTime() + days * DAY_MS);
}

/**
 * The trash-time cut-off for a sweep at `now`: products trashed at or before it
 * are due. Null when nothing can be due yet because retention has not been
 * enabled for a full period.
 */
export function retentionCutoff(now: Date, enabledSince: Date, days: number): Date | null {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  // GREATEST(removed_at, enabledSince) <= cutoff  ⇔  both are <= cutoff.
  return enabledSince.getTime() <= cutoff.getTime() ? cutoff : null;
}
