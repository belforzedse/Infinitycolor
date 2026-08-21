import { Suspense } from "react";
import type { Metadata } from "next";
import OrderSuccessPageClient from "./OrderSuccessPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

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
