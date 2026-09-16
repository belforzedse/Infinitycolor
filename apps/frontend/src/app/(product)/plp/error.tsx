"use client";

import StorefrontRecoveryState from "@/components/storefront/StorefrontRecoveryState";

export default function PLPError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
}) {
  return (
    <StorefrontRecoveryState
      surface="catalog"
      title="دریافت محصولات انجام نشد"
      message="اتصال برقرار نشد. دوباره تلاش کنید."
      error={error}
      onRetry={retry}
    />
  );
}
