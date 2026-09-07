import { redirect } from "next/navigation";
import { safeInternalPath } from "@repo/auth-core/redirects";
import { SITE_URL } from "@/config/site";
import { exactCentralAuthOrigin } from "@/lib/central-auth-origin";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
export const instant = false;

export default async function AuthPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; returnTo?: string }>;
}) {
  const query = await searchParams;
  const safePath = safeInternalPath(query.redirect ?? query.returnTo) ?? "/";
  const authUrl = new URL("/auth", exactCentralAuthOrigin());
  authUrl.searchParams.set("returnTo", new URL(safePath, SITE_URL).toString());
  redirect(authUrl.toString());
}
