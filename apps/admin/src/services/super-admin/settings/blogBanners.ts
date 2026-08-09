import { apiClient } from "@/services";
import type { SuperAdminSettings } from "@/types/super-admin/settings";
import { defaultSettings } from "@/types/super-admin/settings";
import { normalizeSettingsApiResponse } from "./get";

export async function getBlogBannerSettings(): Promise<SuperAdminSettings> {
  const response = await apiClient.get("/settings/blog-banners", { cache: "no-store" });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}

export async function updateBlogBannerSettings(
  settings: Pick<
    SuperAdminSettings,
    | "blogCategoryBannerOrder"
    | "blogDefaultBannerImage"
    | "blogDefaultBannerTitle"
    | "blogDefaultBannerSubtitle"
    | "blogDefaultBannerTitleColor"
    | "blogDefaultBannerSubtitleColor"
    | "blogDefaultBannerLinkText"
    | "blogDefaultBannerLinkColor"
  >,
): Promise<SuperAdminSettings> {
  const response = await apiClient.put("/settings/blog-banners", { data: settings });
  return normalizeSettingsApiResponse(response) ?? defaultSettings();
}
