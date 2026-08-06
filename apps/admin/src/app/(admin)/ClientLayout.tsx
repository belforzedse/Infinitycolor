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
import { canRoleAccessPath, getRoleAdminLandingPath } from "@/constants/roleAccess";
import clsx from "clsx";
import { centralAuth, centralLoginUrl } from "@/lib/central-auth";

type AdminViewport = "mobile" | "tablet" | "desktop";

function useAdminViewport(): AdminViewport | null {
  const [viewport, setViewport] = useState<AdminViewport | null>(null);

  useEffect(() => {
    const tabletQuery = window.matchMedia("(min-width: 768px)");
    const desktopQuery = window.matchMedia("(min-width: 1024px)");
    const updateViewport = () => {
      setViewport(
        desktopQuery.matches
          ? "desktop"
          : tabletQuery.matches
            ? "tablet"
            : "mobile",
      );
    };

    updateViewport();
    tabletQuery.addEventListener("change", updateViewport);
    desktopQuery.addEventListener("change", updateViewport);
    return () => {
      tabletQuery.removeEventListener("change", updateViewport);
      desktopQuery.removeEventListener("change", updateViewport);
    };
  }, []);

  return viewport;
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const setCurrentUser = useSetAtom(currentUserAtom);
  const setUserLoading = useSetAtom(userLoadingAtom);
  const currentUser = useAtomValue(currentUserAtom);
  const viewport = useAdminViewport();
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

  // Backend permissions are authoritative; this centralized route guard keeps
  // Store manager and Founder navigation consistent with those grants.
  const roleBlocked = !canRoleAccessPath(currentUser?.roleName, pathname);

  useEffect(() => {
    if (isAuthorized && roleBlocked) {
      router.replace(getRoleAdminLandingPath(currentUser?.roleName));
    }
  }, [currentUser?.roleName, isAuthorized, roleBlocked, router]);

  if (isLoading || !viewport) {
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

  // Don't render restricted content while the guard redirects.
  if (roleBlocked) {
    return null;
  }

  return (
    <>
      <Suspense fallback={<div>Loading...</div>}>
        <ResponsiveAdminShell viewport={viewport}>
          {children}
        </ResponsiveAdminShell>
      </Suspense>
      <div className="[&_button]:!left-4 [&_button]:!right-auto">
        <ScrollToTop />
      </div>
    </>
  );
}

export function ResponsiveAdminShell({
  children,
  viewport,
}: {
  children: React.ReactNode;
  viewport: AdminViewport;
}) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    viewport === "tablet",
  );
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isMobile = viewport === "mobile";
  const isTablet = viewport === "tablet";

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
    <div
      className={clsx(
        "min-h-screen bg-neutral-50",
        isMobile && "p-4",
        isTablet && "flex gap-3 pl-4 md:pl-6",
        viewport === "desktop" && "flex gap-5 pl-6 lg:pl-10",
      )}
    >
      <div
        key="desktop-sidebar"
        ref={sidebarRef}
        className={clsx(
          "sticky top-0 z-10 h-screen flex-shrink-0 overflow-hidden transition-all duration-300",
          isMobile && "hidden",
          !isMobile && isSidebarCollapsed && "w-[80px]",
          isTablet && !isSidebarCollapsed && "w-[288px]",
          viewport === "desktop" &&
            !isSidebarCollapsed &&
            "w-[288px] xl:w-[304px]",
        )}
      >
        {!isMobile && (
          <Sidebar
            isOpen={true}
            onClose={() => {}}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() =>
              setIsSidebarCollapsed(!isSidebarCollapsed)
            }
          />
        )}
      </div>
      <div
        key="page-content"
        className={clsx(
          "w-full",
          isMobile && "flex flex-col gap-4",
          !isMobile && "flex min-w-0 flex-1 flex-col overflow-visible p-4",
          isTablet && "gap-3",
          viewport === "desktop" && "gap-4 lg:gap-7",
        )}
      >
        <div
          className={clsx(
            "w-full",
            isMobile && "flex flex-col gap-4",
            isTablet &&
              "mx-auto min-w-0 max-w-screen-3xl space-y-3",
            viewport === "desktop" &&
              "mx-auto min-w-0 max-w-screen-3xl space-y-4 lg:space-y-7",
          )}
        >
          <Header
            onMenuClick={
              isMobile ? () => setIsSidebarOpen(!isSidebarOpen) : () => {}
            }
          />
          {children}
        </div>
      </div>
      <div
        key="mobile-sidebar"
        className={clsx(!isMobile && "hidden")}
      >
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
