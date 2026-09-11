import { apiClient } from "@/services";
import type { SuperAdminSettings } from "@/types/super-admin/settings";
import { defaultSettings } from "@/types/super-admin/settings";
import { normalizeSettingsApiResponse } from "./get";

export async function getHomepageCustomSectionSettings(): Promise<SuperAdminSettings> {
  const response = await apiClient.get("/settings/homepage-custom-section", { cache: "no-store" });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}

export async function updateHomepageCustomSectionSettings(
  settings: Pick<
    SuperAdminSettings,
    "homeCustomSectionEnabled" | "homeCustomSectionTitle" | "homeCustomSectionAssignment"
  >,
): Promise<SuperAdminSettings> {
  const response = await apiClient.put("/settings/homepage-custom-section", { data: settings });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}
