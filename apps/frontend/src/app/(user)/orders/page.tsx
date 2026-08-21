import type { Metadata } from "next";
import OrdersPageClient from "./OrdersPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "تاریخچه سفارش‌ها",
  description: "سفارش‌های خود را ردیابی کنید و جزئیات هر سفارش را ببینید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/orders" },
};

export default function OrdersPage() {
  return <OrdersPageClient />;
}
