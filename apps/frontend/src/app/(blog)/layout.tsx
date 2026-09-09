"use client";

import React from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import PLPDesktopHeaderTopBar from "@/components/PLP/Header/DesktopTopBar";
import HeaderDesktopNav from "@/components/PLP/Header/DesktopNav";
import Footer from "@/components/PLP/Footer";
import MobileHeader from "@/components/PLP/Header/Mobile";
import BottomNavigation from "@/components/PLP/BottomNavigation";
import ScrollToTop from "@/components/ScrollToTop";
import AdaptiveQualityBoundary from "@/components/AdaptiveQuality/AdaptiveQualityBoundary";
import {
  noteEnhancementLoaded,
  useAdaptiveHydrated,
  useAdaptiveQuality,
} from "@/lib/adaptive-quality";

const CartDrawer = dynamic(() => import("@/components/ShoppingCart/Drawer"), {
  ssr: false,
});
const GlassSurface = dynamic(() => import("@/components/GlassSurface"), {
  ssr: false,
  loading: () => null,
});

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  const [scrolled, setScrolled] = React.useState(false);
  const [showHeader, setShowHeader] = React.useState(true);
  const pathname = usePathname();
  const lastScrollY = React.useRef(0);
  const hydrated = useAdaptiveHydrated();
  const quality = useAdaptiveQuality();
  const showEnhancedGlass =
    hydrated && scrolled && quality.rendering === "enhanced" && !quality.reducedTransparency;

  React.useEffect(() => {
    if (showEnhancedGlass) noteEnhancementLoaded("glass-surface");
  }, [showEnhancedGlass]);

  React.useEffect(() => {
    const handleScroll = () => {
      const currentY = window.scrollY;
      setScrolled(currentY > 8);

      if (window.innerWidth >= 1024) {
        lastScrollY.current = currentY;
        setShowHeader(true);
        return;
      }

      const isScrollingUp = currentY <= lastScrollY.current;
      const nearTop = currentY < 80;
      setShowHeader(isScrollingUp || nearTop);
      lastScrollY.current = Math.max(0, currentY);
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const headerStyle = !showHeader
    ? { borderBottomWidth: 0, borderBottomColor: "transparent", boxShadow: "none" }
    : undefined;

  const [isStandalone, setIsStandalone] = React.useState(false);

  React.useEffect(() => {
    if (typeof window !== "undefined" && "matchMedia" in window) {
      const mq = window.matchMedia("(display-mode: standalone)");
      setIsStandalone(mq.matches);

      // Optional: listen for changes
      const handleChange = (e: MediaQueryListEvent) => {
        setIsStandalone(e.matches);
      };

      if (mq.addEventListener) {
        mq.addEventListener("change", handleChange);
        return () => mq.removeEventListener("change", handleChange);
      } else if (mq.addListener) {
        mq.addListener(handleChange);
        return () => mq.removeListener(handleChange);
      }
    }
  }, []);

  return (
    <AdaptiveQualityBoundary>
      <div
        dir="rtl"
        className="bg-white pb-[calc(7.5rem+env(safe-area-inset-bottom))] antialiased lg:pb-0"
      >
        {/* Safe area white bar for standalone mode */}
        {isStandalone && (
          <div
            className="fixed left-0 right-0 top-0 z-[100] bg-white"
            style={{ height: "env(safe-area-inset-top)" }}
          />
        )}

        {/* Skip to content for accessibility */}
        <a
          href="#content"
          className="shadow-elevated sr-only fixed left-4 top-4 z-[60] rounded-md bg-black/80 px-3 py-2 text-white focus:not-sr-only"
        >
          پرش به محتوا
        </a>
        <header
          className={`allow-overflow sticky z-[130] transform border-t-0 transition-all duration-200 ${
            scrolled
              ? "glass-panel shadow-sm"
              : "bg-white/80 supports-[backdrop-filter]:bg-white/60"
          } ${showHeader ? "translate-y-0" : "-translate-y-full"}`}
          style={{
            ...headerStyle,
            top: isStandalone ? "env(safe-area-inset-top)" : "0",
          }}
          data-adaptive-surface
        >
          <div className="relative">
            {showEnhancedGlass && (
              <GlassSurface
                disableLayoutStyles
                width="100%"
                height="100%"
                borderRadius={0}
                blur={14}
                brightness={88}
                opacity={0.7}
                backgroundOpacity={0.14}
                saturation={1.3}
                distortionScale={-80}
                redOffset={4}
                greenOffset={7}
                blueOffset={9}
                mixBlendMode="screen"
                className="pointer-events-none absolute inset-0 -z-10 opacity-95"
                contentClassName="hidden"
                style={{ width: "100%", height: "100%" }}
              />
            )}
            <div className="hidden lg:block">
              <PLPDesktopHeaderTopBar />
            </div>

            <div className="lg:hidden">
              <MobileHeader />
            </div>
          </div>
        </header>

        <div className="hidden lg:block">
          <HeaderDesktopNav />
        </div>

        <section key={pathname} id="content">
          {children}
        </section>

        <footer>
          <Footer />
        </footer>

        <BottomNavigation />

        <CartDrawer />

        <ScrollToTop />
      </div>
    </AdaptiveQualityBoundary>
  );
}
