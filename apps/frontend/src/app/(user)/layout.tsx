"use client";

import Footer from "@/components/PLP/Footer";
import Header from "@/components/User/Header";
import ProfileCompletionBanner from "@/components/User/Account/ProfileCompletionBanner";
import dynamic from "next/dynamic";
import { useCart } from "@/contexts/CartContext";
import { useAccountFreshData } from "@/hooks/useAccountFreshData";
import useUser from "@/hooks/useUser";
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  useEffect(() => {
    if (!isLoading && !userData) {
      const requestedPath = `${pathname}${search ? `?${search}` : ""}`;
      const target = `/auth?redirect=${encodeURIComponent(requestedPath)}`;
      router.replace(target);
    }
  }, [isLoading, userData, router, pathname, search]);

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
