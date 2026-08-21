import type { Metadata } from "next";
import AccountPageClient from "./AccountPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "حساب من",
  description: "اطلاعات حساب، سفارش‌ها و تنظیمات شخصی خود را مدیریت کنید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/account" },
};

export default function AccountPage() {
  return <AccountPageClient />;
}
