import { Suspense } from "react";
import type { Metadata } from 'next';
import { SITE_URL } from '@/config/site';
import PaymentSuccessPageClient from './PaymentSuccessPageClient';

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "پرداخت موفق",
  description: "نتیجه پرداخت شما ثبت شد. می‌توانید جزئیات سفارش را مشاهده کنید.",
  robots: {
    index: false,
    follow: false,
  },
  alternates: {
    canonical: `${SITE_URL}/payment/success`,
  },
};

export default function PaymentSuccess() {
  return (
    <Suspense fallback={null}>
      <PaymentSuccessPageClient />
    </Suspense>
  );
}
