"use client";

import Header from "@/components/SuperAdmin/Layout/Header";
import Sidebar from "@/components/SuperAdmin/Layout/Sidebar";
import ScrollToTop from "@/components/ScrollToTop";
import { Suspense, useEffect, useState, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import { UserService } from "@/services";
import { logDiagnostic } from "@/lib/diagnostic-log";
import { HTTP_STATUS } from "@/constants/api";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { useAtomValue, useSetAtom } from "jotai";
import {
  canCapabilitiesAccessPath,
  getAdminLandingPath,
} from "@/constants/roleAccess";
import clsx from "clsx";
import {
  centralAuth,
  centralLoginUrl,
  readAuthStateVersion,
  subscribeToAuthState,
} from "@/lib/central-auth";
import { storefrontOrigin } from "@/config/admin-env";

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

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [authError, setAuthError] = useState(false);
  const setCurrentUser = useSetAtom(currentUserAtom);
  const setUserLoading = useSetAtom(userLoadingAtom);
  const currentUser = useAtomValue(currentUserAtom);
  const mounted = useRef(false);
  const operation = useRef(0);
  const lastCheckRef = useRef<number>(0);
  const isCheckingRef = useRef(false);

  const redirectToStorefront = useCallback(() => {
    window.location.replace(new URL("/account", storefrontOrigin()).toString());
  }, []);

  const checkAuthSilently = useCallback(
    async (initial = false) => {
      if (
        isCheckingRef.current ||
        (!initial && Date.now() - lastCheckRef.current < 30_000)
      )
        return;
      isCheckingRef.current = true;
      lastCheckRef.current = Date.now();
      const run = ++operation.current;
      const version = readAuthStateVersion();
      const current = () =>
        mounted.current &&
        run === operation.current &&
        version === readAuthStateVersion();
      const sessionLost = () => {
        setCurrentUser(null);
        setIsAuthorized(false);
        window.location.replace(centralLoginUrl(pathname));
      };
      try {
        const outcome = await centralAuth.tokenManager.getTokenOutcome();
        if (!current() || outcome.state === "invalidated") return;
        if (outcome.state === "unauthenticated") {
          sessionLost();
          return;
        }
        if (outcome.state === "unavailable") {
          setAuthError(true);
          return;
        }
        const me = await UserService.me(true);
        if (!current()) return;
        setCurrentUser(me);
        if (!me?.isAdmin) {
          setIsAuthorized(false);
          redirectToStorefront();
          return;
        }
        setAuthError(false);
        setIsAuthorized(true);
        logDiagnostic("auth.recovery", {
          operation: "admin_initialize",
          outcome: "recovered",
        });
      } catch (error: unknown) {
        if (!current()) return;
        const status = (error as { status?: number })?.status;
        if (status === HTTP_STATUS.UNAUTHORIZED) {
          const outcome = await centralAuth.tokenManager.getTokenOutcome({
            forceRefresh: true,
          });
          if (!current()) return;
          if (outcome.state === "unauthenticated") {
            sessionLost();
            return;
          }
        }
        if (status === HTTP_STATUS.FORBIDDEN) {
          setIsAuthorized(false);
          redirectToStorefront();
          return;
        }
        setAuthError(true);
        logDiagnostic("auth.recovery", {
          operation: "admin_initialize",
          outcome: "unavailable",
          http_status: status,
        });
      } finally {
        if (run === operation.current) isCheckingRef.current = false;
        if (current()) {
          setUserLoading(false);
          setIsLoading(false);
        }
      }
    },
    [pathname, redirectToStorefront, setCurrentUser, setUserLoading],
  );

  useEffect(() => {
    mounted.current = true;
    setUserLoading(true);
    void checkAuthSilently(true);
    const unsubscribe = subscribeToAuthState((event) => {
      operation.current += 1;
      isCheckingRef.current = false;
      if (event.type === "logout") {
        setCurrentUser(null);
        setIsAuthorized(false);
        setUserLoading(false);
        window.location.replace(centralLoginUrl(pathname));
      } else {
        setCurrentUser(null);
        setIsAuthorized(false);
        void checkAuthSilently(true);
      }
    });
    return () => {
      mounted.current = false;
      operation.current += 1;
      isCheckingRef.current = false;
      unsubscribe();
    };
    // The silent check uses current path; initial loading runs only for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background check on window focus (when user returns to tab)
  useEffect(() => {
    if (!isAuthorized && !authError) return;

    const handleFocus = () => {
      checkAuthSilently();
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [isAuthorized, authError, checkAuthSilently]);

  // Periodic background check (every 5 minutes)
  useEffect(() => {
    if (!isAuthorized && !authError) return;

    const interval = setInterval(
      () => {
        checkAuthSilently();
      },
      5 * 60 * 1000,
    ); // 5 minutes

    return () => {
      clearInterval(interval);
    };
  }, [isAuthorized, authError, checkAuthSilently]);

  // Background check on route changes (throttled)
  useEffect(() => {
    if (!isAuthorized && !authError) return;

    // Throttle route change checks - only if last check was more than 30 seconds ago
    const now = Date.now();
    if (now - lastCheckRef.current >= 30000) {
      checkAuthSilently();
    }
  }, [pathname, isAuthorized, checkAuthSilently]);

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
    return authError ? (
      <main
        className="flex min-h-screen items-center justify-center bg-neutral-50 p-6"
        dir="rtl"
      >
        <section className="w-full max-w-md rounded-prominent border bg-white p-8 text-center">
          <p className="text-neutral-700">بررسی حساب موقتاً ممکن نیست.</p>
          <button
            type="button"
            className="mt-4 rounded-full bg-infinity-primary px-5 py-2 text-white"
            onClick={() => {
              void checkAuthSilently(true);
            }}
          >
            تلاش دوباره
          </button>
        </section>
      </main>
    ) : null;
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
    <main
      className="flex min-h-[55vh] items-center justify-center p-4"
      dir="rtl"
    >
      <section
        className="w-full max-w-lg rounded-2xl border border-amber-200 bg-white p-6 text-center shadow-sm"
        role="alert"
      >
        <p className="text-sm font-semibold text-amber-700">
          دسترسی محدود شده است
        </p>
        <h1 className="mt-2 text-2xl font-bold text-neutral-900">
          اجازه مشاهده این بخش را ندارید
        </h1>
        <p className="mt-3 text-sm leading-7 text-neutral-600">
          سطح دسترسی حساب شما شامل این صفحه نیست. هیچ داده‌ای از این بخش
          بارگذاری نشده است.
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
      if (
        sidebarRef.current &&
        !sidebarRef.current.contains(event.target as Node)
      ) {
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
