"use client";

import StorefrontRecoveryState from "@/components/storefront/StorefrontRecoveryState";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <StorefrontRecoveryState
      surface="root"
      title="بارگذاری این بخش کامل نشد"
      message="اطلاعات شما حفظ شده است. دوباره تلاش کنید یا به فروشگاه برگردید."
      error={error}
      onRetry={reset}
    />
  );
}
