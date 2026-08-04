import { safeInternalPath } from "@repo/auth-core/redirects";
import AuthCompleteClient from "./AuthCompleteClient";

export default async function AuthCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; attempt?: string; error?: string }>;
}) {
  const query = await searchParams;
  const attempt = Math.min(Math.max(Number(query.attempt ?? "0") || 0, 0), 3);
  return (
    <AuthCompleteClient
      returnPath={safeInternalPath(query.returnTo) ?? "/"}
      attempt={attempt}
      callbackError={query.error}
    />
  );
}
