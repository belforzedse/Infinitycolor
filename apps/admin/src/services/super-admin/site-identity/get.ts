import { apiClient } from "@/services";
import type { SiteIdentity } from "@/types/site-identity";
import {
  DEFAULT_SITE_IDENTITY,
  SITE_IDENTITY_POPULATE,
  readSiteIdentityFromApi,
} from "@/services/site-identity";

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    if (
      "response" in error &&
      error.response &&
      typeof error.response === "object" &&
      "status" in error.response
    ) {
      return (error.response as { status: number }).status;
    }
    if ("status" in error) return (error as { status: number }).status;
  }
  return undefined;
}

export async function getSuperAdminSiteIdentity(): Promise<SiteIdentity> {
  try {
    const res = await apiClient.get(`/site-identity?${SITE_IDENTITY_POPULATE}`, {
      cache: "no-store",
    });
    return readSiteIdentityFromApi(res);
  } catch (error: unknown) {
    if (statusOf(error) === 404) return DEFAULT_SITE_IDENTITY;
    throw error;
  }
}
