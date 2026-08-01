import type { Metadata } from "next";
import ForgotPasswordVerifyPageClient from "./ForgotPasswordVerifyPageClient";
import { redirectLegacyAuthPage } from "@/lib/central-auth-redirect";

export const metadata: Metadata = {
  title: "تایید بازیابی رمز عبور",
  description: "کد تایید بازیابی رمز عبور را وارد کنید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/auth/forgot-password/verify" },
};

export default async function ForgotPasswordVerifyPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  redirectLegacyAuthPage(await searchParams);
  return <ForgotPasswordVerifyPageClient />;
}
