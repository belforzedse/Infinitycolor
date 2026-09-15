// @ts-nocheck
/**
 * order-alert-setting controller
 *
 * Reachable only through the capability-gated pair in `routes/custom-router.ts`.
 * There is deliberately no core router for this type.
 */

import { factories } from "@strapi/strapi";

import { writeAuditEvent } from "../../../audit/writer";
import { getAuditContext } from "../../../utils/audit-context";
import {
  ORDER_ALERT_SETTING_UID,
  findOrderAlertSetting,
  normalizeRecipients,
  readStoredRecipients,
} from "../lib/recipients";

const EDITABLE_FIELDS = ["enabled", "recipients"] as const;

function extractPayloadFromRequestBody(body: any) {
  if (body && typeof body === "object" && body.data !== undefined) {
    return body.data;
  }
  return body;
}

function projectSettings(entity: any) {
  return {
    enabled: entity?.enabled !== false,
    recipients: readStoredRecipients(entity),
  };
}

async function ensureEntity(strapi: any) {
  const existing = await findOrderAlertSetting(strapi);
  if (existing) return existing;
  return strapi.entityService.create(ORDER_ALERT_SETTING_UID, { data: {} });
}

function settingChanges(before: any, after: any, fields: readonly string[]) {
  return fields
    .filter(
      (field) =>
        JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null),
    )
    .map((field) => ({
      field,
      // Phone numbers are business data the admin just typed, but the audit log
      // is read by more people than can edit this page. Record only the shape.
      from: field === "recipients" ? { count: readStoredRecipients(before).length } : (before?.[field] ?? null),
      to: field === "recipients" ? { count: readStoredRecipients(after).length } : (after?.[field] ?? null),
    }));
}

function dedupeKey(settingsId: number | string) {
  const requestId = getAuditContext()?.requestId;
  return requestId ? `order-alert-setting:update:${settingsId}:${requestId}` : null;
}

export default factories.createCoreController(ORDER_ALERT_SETTING_UID, ({ strapi }) => ({
  async get(ctx) {
    // Read must not create the row: an unsaved single type is the normal state
    // right after a deploy and reads fine as "disabled, no recipients".
    const entity = await findOrderAlertSetting(strapi);
    ctx.body = {
      data: {
        id: entity?.id ?? null,
        attributes: projectSettings(entity),
      },
    };
  },

  async update(ctx) {
    const payload = extractPayloadFromRequestBody(ctx.request.body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return ctx.badRequest("Order alert payload must be an object");
    }

    const allowed = new Set<string>(EDITABLE_FIELDS);
    const rejectedFields = Object.keys(payload).filter((field) => !allowed.has(field));
    if (rejectedFields.length > 0) {
      return ctx.badRequest("Order alert payload contains unsupported fields", {
        fields: rejectedFields.sort(),
      });
    }

    const data: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(payload, "enabled")) {
      data.enabled = payload.enabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "recipients")) {
      if (!Array.isArray(payload.recipients)) {
        return ctx.badRequest("recipients must be an array");
      }
      data.recipients = normalizeRecipients(payload.recipients);
    }

    const before = await ensureEntity(strapi);
    const updated = await strapi.db.transaction(async ({ trx }) => {
      const entity = await strapi.entityService.update(ORDER_ALERT_SETTING_UID, before.id, {
        data,
        transacting: trx,
      });
      const changes = settingChanges(before, entity, Object.keys(data));
      await writeAuditEvent(
        strapi,
        {
          eventKey: "content.changed",
          result: changes.length > 0 ? "success" : "no_op",
          target: { type: "settings", id: before.id, label: "پیامک اطلاع‌رسانی سفارش" },
          changes,
          summaryFa:
            changes.length > 0
              ? "تنظیمات پیامک اطلاع‌رسانی سفارش تغییر کرد"
              : "تنظیمات پیامک اطلاع‌رسانی سفارش تغییری نکرد",
          summaryEn:
            changes.length > 0
              ? "Order alert SMS settings changed"
              : "Order alert SMS settings did not change",
          metadata: { section: "order_alerts", changedFieldCount: changes.length },
          dedupeKey: dedupeKey(before.id),
        },
        { trx },
      );
      return entity;
    });

    ctx.body = {
      data: {
        id: updated.id,
        attributes: projectSettings(updated),
      },
    };
  },
}));
