"use client";

import StorefrontRecoveryState from "@/components/storefront/StorefrontRecoveryState";

export default function ProductError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <StorefrontRecoveryState
      surface="product"
      title="دریافت اطلاعات فروشگاه انجام نشد"
      message="سبد خرید شما حفظ شده است. اتصال را بررسی کنید و دوباره تلاش کنید."
      error={error}
      onRetry={reset}
    />
  );
}
