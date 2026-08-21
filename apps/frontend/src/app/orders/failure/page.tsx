import { Suspense } from "react";
import type { Metadata } from "next";
import OrderFailurePageClient from "./OrderFailurePageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

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
