import type { Metadata } from "next";
import PasswordPageClient from "./PasswordPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "تغییر رمز عبور",
  description: "برای امنیت بیشتر حساب، رمز عبور خود را به‌روزرسانی کنید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/password" },
};

export default function PasswordPage() {
  return <PasswordPageClient />;
}
