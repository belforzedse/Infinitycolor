import { resolveReturnTarget } from "@repo/auth-core/redirects";
import { LogoutClient } from "@/components/auth/logout-client";
import { getAuthEnv } from "@/server/env";

export default async function LogoutPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const env = getAuthEnv();
  const query = await searchParams;
  const target = resolveReturnTarget(
    query.returnTo,
    env.trustedApplicationOrigins,
    env.defaultStorefrontOrigin,
  );
  const callback = new URL("/auth/logout-callback", new URL(target).origin);
  return <LogoutClient callbackUrl={callback.toString()} />;
}
