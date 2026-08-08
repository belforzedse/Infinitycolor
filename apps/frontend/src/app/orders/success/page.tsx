import { Suspense } from "react";
import type { Metadata } from "next";
import OrderSuccessPageClient from "./OrderSuccessPageClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "ثبت موفق سفارش",
  description: "سفارش شما با موفقیت ثبت شد و در حال انجام است.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/orders/success" },
};

export default function OrderSuccessPage() {
  return (
    <Suspense fallback={null}>
      <OrderSuccessPageClient />
    </Suspense>
  );
}
