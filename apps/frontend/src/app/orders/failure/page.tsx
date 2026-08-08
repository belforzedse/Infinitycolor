import { Suspense } from "react";
import type { Metadata } from "next";
import OrderFailurePageClient from "./OrderFailurePageClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "پرداخت ناموفق",
  description: "پرداخت سفارش با مشکل مواجه شد و سفارش تکمیل نشده است.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/orders/failure" },
};

export default function OrderFailurePage() {
  return (
    <Suspense fallback={null}>
      <OrderFailurePageClient />
    </Suspense>
  );
}
