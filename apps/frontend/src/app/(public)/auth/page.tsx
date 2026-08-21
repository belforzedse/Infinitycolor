import AuthForm from "@/components/Auth/Form";
import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/config/site";
import { redirectLegacyAuthPage } from "@/lib/central-auth-redirect";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default async function AuthPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  redirectLegacyAuthPage(await searchParams);
  return <AuthForm />;
}

export const metadata: Metadata = {
  title: "احراز هویت",
  description: `ورود یا ثبت‌نام در ${SITE_NAME}.`,
  robots: { index: false, follow: false },
  alternates: { canonical: `${SITE_URL}/auth` },
};
