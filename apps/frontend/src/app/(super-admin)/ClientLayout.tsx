"use client";

import Header from "@/components/SuperAdmin/Layout/Header";
import Sidebar from "@/components/SuperAdmin/Layout/Sidebar";
import ScrollToTop from "@/components/ScrollToTop";
import { Suspense, useEffect, useState, useRef, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { UserService } from "@/services";
import { logDiagnostic } from "@/lib/diagnostic-log";
import { HTTP_STATUS } from "@/constants/api";
import { currentUserAtom } from "@/lib/atoms/auth";
import { useAtomValue, useSetAtom } from "jotai";
import { canRoleAccessPath, getRoleAdminLandingPath } from "@/constants/roleAccess";
import clsx from "clsx";
import {
  centralAuth,
  centralLoginUrl,
  readAuthStateVersion,
  subscribeToAuthState,
} from "@/lib/central-auth";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [authError, setAuthError] = useState(false);
  const setCurrentUser = useSetAtom(currentUserAtom);
  const currentUser = useAtomValue(currentUserAtom);
  const mounted = useRef(false);
  const operation = useRef(0);
  const lastCheckRef = useRef<number>(0);
  const isCheckingRef = useRef(false);

  const redirectToPrevious = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [router]);

  const checkAuthSilently = useCallback(
    async (initial = false) => {
      if (isCheckingRef.current || (!initial && Date.now() - lastCheckRef.current < 30_000)) return;
      isCheckingRef.current = true;
      lastCheckRef.current = Date.now();
      const run = ++operation.current;
      const version = readAuthStateVersion();
      const current = () =>
        mounted.current && run === operation.current && version === readAuthStateVersion();
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
          redirectToPrevious();
          return;
        }
        setAuthError(false);
        setIsAuthorized(true);
        logDiagnostic("auth.recovery", { operation: "admin_initialize", outcome: "recovered" });
      } catch (error: unknown) {
        if (!current()) return;
        const status = (error as { status?: number })?.status;
        if (status === HTTP_STATUS.UNAUTHORIZED) {
          const outcome = await centralAuth.tokenManager.getTokenOutcome({ forceRefresh: true });
          if (!current()) return;
          if (outcome.state === "unauthenticated") {
            sessionLost();
            return;
          }
        }
        if (status === HTTP_STATUS.FORBIDDEN) {
          setIsAuthorized(false);
          redirectToPrevious();
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
          setIsLoading(false);
        }
      }
    },
    [pathname, redirectToPrevious, setCurrentUser],
  );

  useEffect(() => {
    mounted.current = true;

    void checkAuthSilently(true);
    const unsubscribe = subscribeToAuthState((event) => {
      operation.current += 1;
      isCheckingRef.current = false;
      if (event.type === "logout") {
        setCurrentUser(null);
        setIsAuthorized(false);

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

  // Backend permissions are authoritative; this centralized route guard keeps
  // Store manager and Founder navigation consistent with those grants.
  const roleBlocked = !canRoleAccessPath(currentUser?.roleName, pathname);

  useEffect(() => {
    if (isAuthorized && roleBlocked) {
      router.replace(getRoleAdminLandingPath(currentUser?.roleName));
    }
  }, [currentUser?.roleName, isAuthorized, roleBlocked, router]);

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
      <main className="p-6 text-center" dir="rtl">
        <p>بررسی حساب موقتاً ممکن نیست.</p>
        <button
          type="button"
          onClick={() => {
            void checkAuthSilently(true);
          }}
        >
          تلاش دوباره
        </button>
      </main>
    ) : null;
  }

  // Don't render restricted content while the guard redirects.
  if (roleBlocked) {
    return null;
  }

  return (
    <>
      <Suspense fallback={<div>Loading...</div>}>
        <div className="block md:hidden">
          <Mobile>{children}</Mobile>
        </div>

        <div className="hidden md:block lg:hidden">
          <Tablet>{children}</Tablet>
        </div>

        <div className="hidden lg:block">
          <Desktop>{children}</Desktop>
        </div>
      </Suspense>
      <div className="[&_button]:!left-4 [&_button]:!right-auto">
        <ScrollToTop />
      </div>
    </>
  );
}

function Mobile({ children }: { children: React.ReactNode }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  return (
    <div className="min-h-screen bg-neutral-50 p-4">
      <div className="flex w-full flex-col gap-4">
        <Header onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)} />
        {children}
        <Sidebar
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
          enableMobileDrawer
        />
      </div>
    </div>
  );
}

function Tablet({ children }: { children: React.ReactNode }) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Handle click outside to collapse sidebar on tablets
  useEffect(() => {
    // Only add listener when sidebar is expanded
    if (isSidebarCollapsed) return;

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
  }, [isSidebarCollapsed]);

  return (
    <div className="flex min-h-screen gap-3 bg-neutral-50 pl-4 md:pl-6">
      <div
        ref={sidebarRef}
        className={clsx(
          "sticky top-0 z-10 h-screen flex-shrink-0 overflow-y-auto transition-all duration-300",
          isSidebarCollapsed ? "w-[80px]" : "w-[280px]",
        )}
      >
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        />
      </div>
      <div className="flex w-full min-w-0 flex-1 flex-col gap-3 overflow-visible p-4">
        <div className="mx-auto w-full min-w-0 max-w-screen-3xl space-y-3">
          <Header onMenuClick={() => {}} />
          {children}
        </div>
      </div>
    </div>
  );
}

function Desktop({ children }: { children: React.ReactNode }) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  return (
    <div className="flex min-h-screen gap-5 bg-neutral-50 pl-6 lg:pl-10">
      <div
        className={clsx(
          "sticky top-0 z-10 h-screen flex-shrink-0 overflow-y-auto transition-all duration-300",
          isSidebarCollapsed ? "w-[80px]" : "w-[250px]",
        )}
      >
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        />
      </div>
      <div className="flex w-full min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-7">
        <div className="mx-auto w-full min-w-0 max-w-screen-3xl space-y-4 lg:space-y-7">
          <Header onMenuClick={() => {}} />
          {children}
        </div>
      </div>
    </div>
  );
}
