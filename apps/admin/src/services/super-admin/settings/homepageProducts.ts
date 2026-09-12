import { apiClient } from "@/services";
import type { SuperAdminSettings } from "@/types/super-admin/settings";
import { defaultSettings } from "@/types/super-admin/settings";
import { normalizeSettingsApiResponse } from "./get";

export async function getHomepageProductSettings(): Promise<SuperAdminSettings> {
  const response = await apiClient.get("/settings/homepage-products", { cache: "no-store" });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}

export async function updateHomepageProductSettings(
  settings: Pick<
    SuperAdminSettings,
    | "homeNewestProductIds"
    | "homeFavoriteProductIds"
    | "homeDiscountedProductIds"
    | "homeWeeklyPicksEnabled"
    | "homeWeeklyPicksProductIds"
    | "homeEveryoneFollowsEnabled"
    | "homeEveryoneFollowsProductIds"
  >,
): Promise<SuperAdminSettings> {
  const response = await apiClient.put("/settings/homepage-products", { data: settings });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}
