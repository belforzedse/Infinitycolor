import { safeInternalRedirect } from "@/utils/authRedirect";
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
      returnPath={safeInternalRedirect(query.returnTo) ?? "/"}
      attempt={attempt}
      callbackError={query.error}
    />
  );
}
