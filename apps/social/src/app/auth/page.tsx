import type { Metadata } from "next";
import AuthForm from "@/components/Auth/Form";
import { SITE_NAME } from "@/config/site";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default function AuthPage() {
  return <AuthForm />;
}

export const metadata: Metadata = {
  title: "ورود",
  description: `ورود یا ثبت‌نام در ${SITE_NAME}.`,
  robots: { index: false, follow: false },
};
