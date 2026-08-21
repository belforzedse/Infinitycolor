import { Suspense } from "react";
import type { Metadata } from "next";
import ForgotPasswordPageClient from "./ForgotPasswordPageClient";
import { redirectLegacyAuthPage } from "@/lib/central-auth-redirect";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "بازیابی رمز عبور",
  description: "رمز عبور حساب کاربری خود را بازیابی کنید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/auth/forgot-password" },
};

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  redirectLegacyAuthPage(await searchParams);
  return (
    <Suspense fallback={null}>
      <ForgotPasswordPageClient />
    </Suspense>
  );
}
