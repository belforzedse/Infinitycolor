import "server-only";

import { redirect } from "next/navigation";
import { safeInternalPath } from "@repo/auth-core/redirects";
import { SITE_URL } from "@/config/site";
import { exactCentralAuthOrigin } from "@/lib/central-auth-origin";

export function redirectLegacyAuthPage(search?: { redirect?: string }): void {
  if (process.env.CENTRAL_AUTH_CUTOVER_ENABLED !== "true") return;
  const safePath = safeInternalPath(search?.redirect) ?? "/";
  const authUrl = new URL("/auth", exactCentralAuthOrigin());
  authUrl.searchParams.set("returnTo", new URL(safePath, SITE_URL).toString());
  redirect(authUrl.toString());
}
