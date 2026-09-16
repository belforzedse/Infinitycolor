"use client";

import StorefrontRecoveryState from "@/components/storefront/StorefrontRecoveryState";

export default function UserError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
}) {
  return (
    <StorefrontRecoveryState
      surface="account"
      title="دریافت اطلاعات حساب کامل نشد"
      message="هیچ تغییری در حساب شما ثبت نشده است. دوباره تلاش کنید."
      error={error}
      onRetry={retry}
      secondaryHref="/account"
      secondaryLabel="بازگشت به حساب کاربری"
    />
  );
}
