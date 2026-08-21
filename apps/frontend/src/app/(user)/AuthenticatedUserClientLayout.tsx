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

const CartDrawer = dynamic(() => import("@/components/ShoppingCart/Drawer"), { ssr: false });

export default function AuthenticatedUserClientLayout({ children }: { children: React.ReactNode }) {
  useAccountFreshData();
  const { isDrawerOpen } = useCart();
  const { userData, isLoading } = useUser();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !userData) {
      const search = typeof window !== "undefined" ? window.location.search : "";
      const requestedPath = `${pathname}${search}`;
      router.replace(`/auth?redirect=${encodeURIComponent(requestedPath)}`);
    }
  }, [isLoading, userData, router, pathname]);

  if (isLoading || !userData) return null;

  return (
    <AdaptiveQualityBoundary>
      <div className="public-layout bg-white pt-5">
        <StorefrontContainer>
          <Header />
          <ProfileCompletionBanner />
        </StorefrontContainer>
        {children}
        <Footer />
        {isDrawerOpen && <CartDrawer />}
      </div>
    </AdaptiveQualityBoundary>
  );
}
