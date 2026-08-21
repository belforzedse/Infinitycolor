import { safeInternalRedirect } from "@/utils/authRedirect";
import AuthCompleteClient from "./AuthCompleteClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default async function AuthCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; attempt?: string; error?: string }>;
}) {
  const query = await searchParams;
  const attempt = Math.min(Math.max(Number(query.attempt ?? "0") || 0, 0), 3);
  return (
    <AuthCompleteClient
      returnPath={safeInternalRedirect(query.returnTo) ?? "/"}
      attempt={attempt}
      callbackError={query.error}
    />
  );
}
