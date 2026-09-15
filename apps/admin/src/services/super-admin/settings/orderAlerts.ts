import { apiClient } from "@/services";

/**
 * Staff SMS recipients for the «در حال انجام» order alert.
 *
 * Deliberately not part of `SuperAdminSettings`: these numbers live in their own
 * private single type on the backend, because `api::settings.settings` is served
 * unauthenticated through `GET /site-settings` and edge-cached.
 */
export type OrderAlertRecipient = {
  label: string;
  phone: string;
  enabled: boolean;
};

export type OrderAlertSettings = {
  enabled: boolean;
  recipients: OrderAlertRecipient[];
};

export const defaultOrderAlertSettings = (): OrderAlertSettings => ({
  enabled: true,
  recipients: [],
});

function normalizeResponse(res: unknown): OrderAlertSettings {
  const attributes = (res as { data?: { attributes?: Record<string, unknown> } })?.data?.attributes;
  if (!attributes) return defaultOrderAlertSettings();

  const recipients = Array.isArray(attributes.recipients)
    ? (attributes.recipients as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.phone !== "string" || !row.phone) return [];
        return [
          {
            label: typeof row.label === "string" ? row.label : "",
            phone: row.phone,
            enabled: row.enabled !== false,
          },
        ];
      })
    : [];

  return {
    enabled: attributes.enabled !== false,
    recipients,
  };
}

export async function getOrderAlertSettings(): Promise<OrderAlertSettings> {
  const response = await apiClient.get("/settings/order-alerts", { cache: "no-store" });
  return normalizeResponse(response);
}

export async function updateOrderAlertSettings(
  settings: OrderAlertSettings,
): Promise<OrderAlertSettings> {
  const response = await apiClient.put("/settings/order-alerts", { data: settings });
  return normalizeResponse(response);
}
