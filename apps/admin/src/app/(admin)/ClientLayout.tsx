"use client";

import Header from "@/components/SuperAdmin/Layout/Header";
import Sidebar from "@/components/SuperAdmin/Layout/Sidebar";
import ScrollToTop from "@/components/ScrollToTop";
import { Suspense, useEffect, useState, useRef, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { UserService } from "@/services";
import { HTTP_STATUS } from "@/constants/api";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { useAtomValue, useSetAtom } from "jotai";
import { canCapabilitiesAccessPath, getAdminLandingPath } from "@/constants/roleAccess";
import clsx from "clsx";
import { centralAuth, centralLoginUrl } from "@/lib/central-auth";

/**
 * Layout is expressed in CSS (see ResponsiveAdminShell); this hook exists only
 * for the two things CSS genuinely cannot do: mounting the mobile drawer (a
 * focus-trapping headless-ui Dialog that must not exist at desktop widths) and
 * seeding the tablet default-collapsed sidebar. It never gates rendering, so
 * the shell paints on the first pass at every width.
 */
function useAdminViewportBehavior() {
  const [state, setState] = useState({
    isMobile: false,
    isTablet: false,
    ready: false,
  });

  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 767px)");
    const tabletQuery = window.matchMedia(
      "(min-width: 768px) and (max-width: 1023px)",
    );
    const update = () =>
      setState({
        isMobile: mobileQuery.matches,
        isTablet: tabletQuery.matches,
        ready: true,
      });

    update();
    mobileQuery.addEventListener("change", update);
    tabletQuery.addEventListener("change", update);
    return () => {
      mobileQuery.removeEventListener("change", update);
      tabletQuery.removeEventListener("change", update);
    };
  }, []);

  return state;
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const setCurrentUser = useSetAtom(currentUserAtom);
  const setUserLoading = useSetAtom(userLoadingAtom);
  const currentUser = useAtomValue(currentUserAtom);
  const hasRunRef = useRef(false);
  const lastCheckRef = useRef<number>(0);
  const isCheckingRef = useRef(false);

  const redirectToPrevious = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [router]);

  // Silent background auth check - doesn't show loading state
  const checkAuthSilently = useCallback(async () => {
    // Prevent concurrent checks
    if (isCheckingRef.current) return;

    // Throttle: don't check more than once per 30 seconds
    const now = Date.now();
    if (now - lastCheckRef.current < 30000) return;

    isCheckingRef.current = true;
    lastCheckRef.current = now;

    try {
      const token = await centralAuth.tokenManager.getToken();
      if (!token) {
        setIsAuthorized(false);
        window.location.replace(centralLoginUrl(pathname));
        return;
      }

      const me = await UserService.me(true);
      setCurrentUser(me);

      // Check if user is still admin - update isAuthorized state and redirect immediately
      if (!me?.isAdmin) {
        setIsAuthorized(false);
        // Redirect immediately - don't wait
        redirectToPrevious();
        return;
      }

      // Ensure isAuthorized is true if user is admin
      setIsAuthorized(true);
    } catch (error: any) {
      setCurrentUser(null);

      if (error?.status === HTTP_STATUS.UNAUTHORIZED) {
        setIsAuthorized(false);
        window.location.replace(centralLoginUrl(pathname));
        return;
      }
      if (error?.status === HTTP_STATUS.FORBIDDEN) {
        setIsAuthorized(false);
        redirectToPrevious();
        return;
      }
      // For other errors, don't redirect - might be temporary network issues
      // But still update isAuthorized if we can't verify
      setIsAuthorized(false);
    } finally {
      isCheckingRef.current = false;
    }
  }, [router, setCurrentUser, redirectToPrevious]);

  // Initial mount check - with loading state
  useEffect(() => {
    // Prevent running multiple times
    if (hasRunRef.current) return;
    hasRunRef.current = true;

    let isMounted = true;
    setIsLoading(true);
    setUserLoading(true);

    const run = async () => {
      const token = await centralAuth.tokenManager.getToken();
      if (!token) {
        window.location.replace(centralLoginUrl(pathname));
        return;
      }
      setCurrentUser(null);
      return UserService.me(true);
    };
    run()
      .then((me) => {
        if (!isMounted || !me) return;
        // Update the cached user data with fresh data
        setCurrentUser(me);
        setUserLoading(false);

        if (!me?.isAdmin) {
          redirectToPrevious();
          return;
        }
        setIsAuthorized(true);
        setIsLoading(false);
        // Update last check time for initial mount
        lastCheckRef.current = Date.now();
      })
      .catch((error: any) => {
        if (!isMounted) return;
        // Clear user data on auth errors
        setCurrentUser(null);
        setUserLoading(false);

        if (error?.status === HTTP_STATUS.UNAUTHORIZED) {
          window.location.replace(centralLoginUrl(pathname));
          return;
        }
        if (error?.status === HTTP_STATUS.FORBIDDEN) {
          redirectToPrevious();
          return;
        }
        redirectToPrevious();
      });

    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount - use ref to prevent re-runs

  // Background check on window focus (when user returns to tab)
  useEffect(() => {
    if (!isAuthorized) return; // Only check if already authorized

    const handleFocus = () => {
      checkAuthSilently();
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [isAuthorized, checkAuthSilently]);

  // Periodic background check (every 5 minutes)
  useEffect(() => {
    if (!isAuthorized) return; // Only check if already authorized

    const interval = setInterval(
      () => {
        checkAuthSilently();
      },
      5 * 60 * 1000,
    ); // 5 minutes

    return () => {
      clearInterval(interval);
    };
  }, [isAuthorized, checkAuthSilently]);

  // Background check on route changes (throttled)
  useEffect(() => {
    if (!isAuthorized) return; // Only check if already authorized

    // Throttle route change checks - only if last check was more than 30 seconds ago
    const now = Date.now();
    if (now - lastCheckRef.current >= 30000) {
      checkAuthSilently();
    }
  }, [pathname, isAuthorized, checkAuthSilently]);

  // Immediately redirect if user loses authorization
  useEffect(() => {
    if (!isLoading && !isAuthorized) {
      // User is no longer authorized - redirect immediately
      redirectToPrevious();
    }
  }, [isLoading, isAuthorized, redirectToPrevious]);

  const roleBlocked = !canCapabilitiesAccessPath(
    currentUser?.capabilities,
    pathname,
    currentUser?.adminRole,
  );

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700"
          aria-label="Loading admin view"
        />
      </div>
    );
  }

  if (!isAuthorized) {
    return null;
  }

  return (
    <>
      <Suspense fallback={<div>Loading...</div>}>
        <ResponsiveAdminShell>
          {roleBlocked ? (
            <ForbiddenAdminView
              landingPath={getAdminLandingPath(
                currentUser?.capabilities,
                currentUser?.adminRole,
              )}
            />
          ) : (
            children
          )}
        </ResponsiveAdminShell>
      </Suspense>
      <div className="[&_button]:!left-4 [&_button]:!right-auto">
        <ScrollToTop />
      </div>
    </>
  );
}

function ForbiddenAdminView({ landingPath }: { landingPath: string }) {
  return (
    <main className="flex min-h-[55vh] items-center justify-center p-4" dir="rtl">
      <section
        className="w-full max-w-lg rounded-2xl border border-amber-200 bg-white p-6 text-center shadow-sm"
        role="alert"
      >
        <p className="text-sm font-semibold text-amber-700">دسترسی محدود شده است</p>
        <h1 className="mt-2 text-2xl font-bold text-neutral-900">اجازه مشاهده این بخش را ندارید</h1>
        <p className="mt-3 text-sm leading-7 text-neutral-600">
          سطح دسترسی حساب شما شامل این صفحه نیست. هیچ داده‌ای از این بخش بارگذاری نشده است.
        </p>
        <a
          href={landingPath}
          className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-infinity-primary px-5 py-2.5 text-sm font-semibold text-white"
        >
          رفتن به صفحه مجاز
        </a>
      </section>
    </main>
  );
}

export function ResponsiveAdminShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const { isMobile, isTablet, ready } = useAdminViewportBehavior();

  // Tablets start with the sidebar collapsed. Seeded once the viewport is
  // known rather than gating the first paint on it; the width transition is
  // suppressed until then so this never reads as an animation.
  const hasSeededCollapse = useRef(false);
  useEffect(() => {
    if (!ready || hasSeededCollapse.current) return;
    hasSeededCollapse.current = true;
    if (isTablet) setIsSidebarCollapsed(true);
  }, [ready, isTablet]);

  // Handle click outside to collapse sidebar on tablets
  useEffect(() => {
    // Only add listener when sidebar is expanded
    if (!isTablet || isSidebarCollapsed) return;

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      // Only collapse if click is outside sidebar
      if (sidebarRef.current && !sidebarRef.current.contains(event.target as Node)) {
        setIsSidebarCollapsed(true);
      }
    };

    // Add listeners for both mouse and touch events
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [isSidebarCollapsed, isTablet]);

  return (
    <div className="min-h-screen bg-neutral-50 p-4 md:flex md:gap-3 md:p-0 md:pl-6 lg:gap-5 lg:pl-10">
      <div
        key="desktop-sidebar"
        ref={sidebarRef}
        className={clsx(
          "sticky top-0 z-10 hidden h-screen flex-shrink-0 overflow-hidden md:block",
          ready && "transition-all duration-300",
          isSidebarCollapsed ? "md:w-[80px]" : "md:w-[288px] xl:w-[304px]",
        )}
      >
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        />
      </div>
      <div
        key="page-content"
        className="flex w-full flex-col gap-4 md:min-w-0 md:flex-1 md:gap-3 md:overflow-visible md:p-4 lg:gap-7"
      >
        <div className="flex w-full flex-col gap-4 md:mx-auto md:min-w-0 md:max-w-screen-3xl md:gap-3 lg:gap-7">
          <Header onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)} />
          {children}
        </div>
      </div>
      {/* Focus-trapping drawer: mounted only at phone widths. */}
      <div key="mobile-sidebar" className={clsx(!isMobile && "hidden")}>
        {isMobile && (
          <Sidebar
            isOpen={isSidebarOpen}
            onClose={() => setIsSidebarOpen(false)}
            enableMobileDrawer
          />
        )}
      </div>
    </div>
  );
}
