"use client";

import StorefrontRecoveryState from "@/components/storefront/StorefrontRecoveryState";

export default function PLPError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <StorefrontRecoveryState
      surface="catalog"
      title="دریافت محصولات انجام نشد"
      message="این وضعیت به معنی خالی بودن فروشگاه نیست. اتصال برقرار نشد؛ دوباره تلاش کنید."
      error={error}
      onRetry={reset}
    />
  );
}
