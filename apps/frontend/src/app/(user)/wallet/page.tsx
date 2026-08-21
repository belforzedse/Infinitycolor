import { Suspense } from "react";
import type { Metadata } from "next";
import WalletPageClient from "./WalletPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "کیف پول",
  description: "موجودی کیف پول و سوابق تراکنش‌های خود را مدیریت کنید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/wallet" },
};

export default function WalletPage() {
  return (
    <Suspense fallback={null}>
      <WalletPageClient />
    </Suspense>
  );
}
