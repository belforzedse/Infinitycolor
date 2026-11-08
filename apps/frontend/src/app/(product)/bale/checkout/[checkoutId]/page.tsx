import type { Metadata } from "next";
import { Suspense } from "react";
import BaleCheckoutClient from "./BaleCheckoutClient";

export const instant = false;

export const metadata: Metadata = {
  title: "تسویه حساب سفارش بله",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

async function BaleCheckout({ params }: { params: Promise<{ checkoutId: string }> }) {
  const { checkoutId } = await params;
  return <BaleCheckoutClient key={checkoutId} checkoutId={checkoutId} />;
}

export default function BaleCheckoutPage(props: { params: Promise<{ checkoutId: string }> }) {
  return (
    <Suspense fallback={null}>
      <BaleCheckout {...props} />
    </Suspense>
  );
}
