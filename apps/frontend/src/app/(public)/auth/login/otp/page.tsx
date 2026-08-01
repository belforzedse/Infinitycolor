import type { Metadata } from "next";
import OtpLoginPageClient from "./OtpLoginPageClient";
import { redirectLegacyAuthPage } from "@/lib/central-auth-redirect";

export const metadata: Metadata = {
  title: "ورود با کد تایید",
  description: "ورود به حساب کاربری با کد تایید پیامکی.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/auth/login/otp" },
};

export default async function OtpLoginPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  redirectLegacyAuthPage(await searchParams);
  return <OtpLoginPageClient />;
}
