import type { Metadata } from "next";
import OrderSuccessPageClient from "./OrderSuccessPageClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "ثبت موفق سفارش",
  description: "سفارش شما با موفقیت ثبت شد و در حال پردازش است.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/orders/success" },
};

export default function OrderSuccessPage() {
  return <OrderSuccessPageClient />;
}
