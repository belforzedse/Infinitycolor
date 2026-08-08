"use client";

import Footer from "@/components/PLP/Footer";
import Header from "@/components/User/Header";
import ProfileCompletionBanner from "@/components/User/Account/ProfileCompletionBanner";
import dynamic from "next/dynamic";
import { useCart } from "@/contexts/CartContext";
import { useAccountFreshData } from "@/hooks/useAccountFreshData";
import useUser from "@/hooks/useUser";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { StorefrontContainer } from "@/components/storefront";
import AdaptiveQualityBoundary from "@/components/AdaptiveQuality/AdaptiveQualityBoundary";

const CartDrawer = dynamic(() => import("@/components/ShoppingCart/Drawer"), {
  ssr: false,
});

export default function AuthenticatedUserLayout({ children }: { children: React.ReactNode }) {
  // Enable automatic data refresh for account pages (15 second debounce)
  // This applies to /orders, /wallet, /addresses, /account, etc.
  useAccountFreshData();
  const { isDrawerOpen } = useCart();
  const { userData, isLoading } = useUser();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !userData) {
      // Read the query string from the browser instead of useSearchParams().
      // Calling useSearchParams in this layout forced every child page under a
      // Suspense CSR bailout; the previous root Suspense wrapper "fixed" the
      // build while also locking missing-route responses at HTTP 200.
      const search = typeof window !== "undefined" ? window.location.search : "";
      const requestedPath = `${pathname}${search}`;
      const target = `/auth?redirect=${encodeURIComponent(requestedPath)}`;
      router.replace(target);
    }
  }, [isLoading, userData, router, pathname]);

  // Never expose the protected page shell while auth is unresolved or absent.
  // This also covers stale/forged routing markers; API authorization remains authoritative.
  if (isLoading || !userData) {
    return null;
  }
  return (
    <AdaptiveQualityBoundary>
      <div className="public-layout bg-white pt-5">
        <StorefrontContainer>
          <Header />
          <ProfileCompletionBanner />
        </StorefrontContainer>

        {children}

        <Footer />

        {/* Cart Drawer */}
        {isDrawerOpen && <CartDrawer />}
      </div>
    </AdaptiveQualityBoundary>
  );
}
