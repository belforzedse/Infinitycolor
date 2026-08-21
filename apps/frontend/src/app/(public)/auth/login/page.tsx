import { Suspense } from "react";
import type { Metadata } from "next";
import LoginPageClient from "./LoginPageClient";
import { redirectLegacyAuthPage } from "@/lib/central-auth-redirect";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "ورود",
  description: "ورود به حساب کاربری در فروشگاه پوشاک اینفینیتی.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/auth/login" },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  redirectLegacyAuthPage(await searchParams);
  return (
    <Suspense fallback={null}>
      <LoginPageClient />
    </Suspense>
  );
}
