"use client";

import StorefrontRecoveryState from "@/components/storefront/StorefrontRecoveryState";

export default function UserError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <StorefrontRecoveryState
      surface="account"
      title="دریافت اطلاعات حساب کامل نشد"
      message="اطلاعات حساب نمایش داده نشد و هیچ تغییری ثبت نشده است. دوباره تلاش کنید."
      error={error}
      onRetry={reset}
      secondaryHref="/account"
      secondaryLabel="بازگشت به حساب کاربری"
    />
  );
}
