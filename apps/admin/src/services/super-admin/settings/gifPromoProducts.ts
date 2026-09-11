import { apiClient } from "@/services";
import type { SuperAdminSettings } from "@/types/super-admin/settings";
import { defaultSettings } from "@/types/super-admin/settings";
import { normalizeSettingsApiResponse } from "./get";

export async function getGifPromoProductSettings(): Promise<SuperAdminSettings> {
  const response = await apiClient.get("/settings/gif-promo-products", { cache: "no-store" });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}

export async function updateGifPromoProductSettings(
  settings: Pick<
    SuperAdminSettings,
    "homeGifPromoSlot1Assignment" | "homeGifPromoSlot2Assignment"
  >,
): Promise<SuperAdminSettings> {
  const response = await apiClient.put("/settings/gif-promo-products", { data: settings });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}
