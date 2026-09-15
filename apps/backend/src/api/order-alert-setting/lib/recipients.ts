/**
 * Staff notification recipients for the «در حال انجام» order alert.
 *
 * Kept in their own single type rather than `api::settings.settings` on purpose:
 * that one is served unauthenticated through `GET /site-settings` and is
 * edge-cached, so anything stored there is public. This type has no core router
 * and is reachable only through the capability-gated pair in
 * `routes/custom-router.ts`.
 */

import { normalizeIranMobile } from "../../../services/sms/phone";

export const ORDER_ALERT_SETTING_UID = "api::order-alert-setting.order-alert-setting";

export type StaffAlertRecipient = {
  label: string;
  phone: string;
  enabled: boolean;
};

const MAX_RECIPIENTS = 20;
const MAX_LABEL_LENGTH = 60;

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * Drops rows whose phone is not a valid Iranian mobile rather than rejecting the
 * whole payload: the admin form validates first, and a single bad row must not
 * make the rest of the list unsaveable.
 */
export function normalizeRecipients(value: unknown): StaffAlertRecipient[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: StaffAlertRecipient[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const phone = normalizeIranMobile((entry as any).phone);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    normalized.push({
      label: normalizeLabel((entry as any).label),
      phone,
      enabled: (entry as any).enabled !== false,
    });
    if (normalized.length >= MAX_RECIPIENTS) break;
  }

  return normalized;
}

export function readStoredRecipients(entity: any): StaffAlertRecipient[] {
  return normalizeRecipients(entity?.recipients);
}

/**
 * Returns the entity if it exists, or `null`. Callers on the read path must not
 * create it — the row is absent until an admin saves the form for the first
 * time, which is the normal state right after a deploy.
 */
export async function findOrderAlertSetting(strapi: any) {
  return strapi.db.query(ORDER_ALERT_SETTING_UID).findOne({ where: {} });
}

/**
 * Normalized `+989…` numbers for enabled recipients, or `[]` when the alert is
 * switched off or the single type has never been saved.
 */
export async function getActiveStaffRecipients(strapi: any): Promise<StaffAlertRecipient[]> {
  const entity = await findOrderAlertSetting(strapi);
  if (!entity) return [];
  if (entity.enabled === false) return [];
  return readStoredRecipients(entity).filter((recipient) => recipient.enabled);
}
