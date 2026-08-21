import { Suspense } from "react";
import type { Metadata } from "next";
import ForgotPasswordVerifyPageClient from "./ForgotPasswordVerifyPageClient";
import { redirectLegacyAuthPage } from "@/lib/central-auth-redirect";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "تایید بازیابی رمز عبور",
  description: "کد تایید بازیابی رمز عبور را وارد کنید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/auth/forgot-password/verify" },
};

export default async function ForgotPasswordVerifyPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  redirectLegacyAuthPage(await searchParams);
  return (
    <Suspense fallback={null}>
      <ForgotPasswordVerifyPageClient />
    </Suspense>
  );
}
