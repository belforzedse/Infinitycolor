import type { Metadata } from "next";
import AddressesPageClient from "./AddressesPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "آدرس‌های من",
  description: "آدرس‌های ذخیره‌شده برای پرداخت سریع و ارسال سفارش را مدیریت کنید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/addresses" },
};

export default function AddressesPage() {
  return <AddressesPageClient />;
}
