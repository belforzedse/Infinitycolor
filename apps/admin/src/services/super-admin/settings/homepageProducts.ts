import { apiClient } from "@/services";
import type { SuperAdminSettings } from "@/types/super-admin/settings";
import { defaultSettings } from "@/types/super-admin/settings";
import { normalizeSettingsApiResponse } from "./get";

export async function getHomepageProductSettings(): Promise<SuperAdminSettings> {
  const response = await apiClient.get("/settings/homepage-products", { cache: "no-store" });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}

/**
 * Partial on purpose: the backend writes only the fields the payload actually carries
 * (see `updateHomepageProducts`' `hasOwnProperty` loop in the settings controller), so
 * a caller that owns one product — ProductHomepageSectionsCard — can send just the
 * sections it changed instead of rewriting all seven from a stale snapshot.
 */
export async function updateHomepageProductSettings(
  settings: Partial<
    Pick<
      SuperAdminSettings,
      | "homeNewestProductIds"
      | "homeFavoriteProductIds"
      | "homeDiscountedProductIds"
      | "homeWeeklyPicksEnabled"
      | "homeWeeklyPicksProductIds"
      | "homeEveryoneFollowsEnabled"
      | "homeEveryoneFollowsProductIds"
    >
  >,
): Promise<SuperAdminSettings> {
  const response = await apiClient.put("/settings/homepage-products", { data: settings });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}
