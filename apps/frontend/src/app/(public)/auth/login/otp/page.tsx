import { Suspense } from "react";
import type { Metadata } from "next";
import OtpLoginPageClient from "./OtpLoginPageClient";
import { redirectLegacyAuthPage } from "@/lib/central-auth-redirect";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "ورود با کد تأیید",
  description: "ورود به حساب کاربری با کد تأیید پیامکی.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/auth/login/otp" },
};

export default async function OtpLoginPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  redirectLegacyAuthPage(await searchParams);
  return (
    <Suspense fallback={null}>
      <OtpLoginPageClient />
    </Suspense>
  );
}
