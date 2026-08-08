import { Suspense } from "react";
import type { Metadata } from "next";
import RegisterInfoPageClient from "./RegisterInfoPageClient";
import { redirectLegacyAuthPage } from "@/lib/central-auth-redirect";

export const metadata: Metadata = {
  title: "تکمیل اطلاعات ثبت‌نام",
  description: "اطلاعات حساب کاربری خود را تکمیل کنید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/auth/register/info" },
};

export default async function RegisterInfoPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  redirectLegacyAuthPage(await searchParams);
  return (
    <Suspense fallback={null}>
      <RegisterInfoPageClient />
    </Suspense>
  );
}
