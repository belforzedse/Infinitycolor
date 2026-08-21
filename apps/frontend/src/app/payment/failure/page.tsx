import { Suspense } from "react";
import type { Metadata } from "next";
import PaymentFailurePageClient from "./PaymentFailurePageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "پرداخت ناموفق",
  description: "پرداخت شما با مشکل مواجه شد و تکمیل نشده است.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/payment/failure" },
};

export default function PaymentFailurePage() {
  return (
    <Suspense fallback={null}>
      <PaymentFailurePageClient />
    </Suspense>
  );
}
