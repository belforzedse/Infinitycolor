import { Suspense } from "react";
import type { Metadata } from "next";
import RegisterPageClient from "./RegisterPageClient";
import { redirectLegacyAuthPage } from "@/lib/central-auth-redirect";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "ثبت‌نام",
  description: "ایجاد حساب کاربری در فروشگاه پوشاک اینفینیتی.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/auth/register" },
};

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  redirectLegacyAuthPage(await searchParams);
  return (
    <Suspense fallback={null}>
      <RegisterPageClient />
    </Suspense>
  );
}
