"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useRef, useState } from "react";
import {
  AuthHandoffError,
  authErrorStatus,
  updateRouteHint,
  withTransientAuthRetry,
} from "@repo/auth-core/browser";
import { jotaiStore } from "@/lib/jotaiStore";
import {
  currentUserAtom,
  userErrorAtom,
  userLoadingAtom,
} from "@/lib/atoms/auth";
import {
  centralAuth,
  centralAuthOrigin,
  initializeCentralAuthBrowser,
  readAuthStateVersion,
} from "@/lib/central-auth";
import { logDiagnostic } from "@/lib/diagnostic-log";
import UserService from "@/services/user";
import { getAdminLandingPath } from "@/constants/roleAccess";
import { adminOrigin, storefrontOrigin } from "@/config/admin-env";

export default function AuthCompleteClient({
  returnPath,
  attempt,
  callbackError,
}: {
  returnPath: string;
  attempt: number;
  callbackError?: string;
}) {
  const started = useRef<string | null>(null);
  const reportedTerminal = useRef(new Set<string>());
  const [fatal, setFatal] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const runKey = `${attempt}:${retryKey}`;
    if (started.current === runKey) return;
    started.current = runKey;
    setFatal("");
    let active = true;
    initializeCentralAuthBrowser();
    const identity = readAuthStateVersion();
    const isCurrent = () => active && identity === readAuthStateVersion();
    let confirmedSessionLoss = false;
    let stage = "token";
    const reportTerminal = (
      outcome: "unavailable" | "exhausted",
      status?: number,
    ) => {
      const key = `${stage}:${outcome}`;
      if (reportedTerminal.current.has(key)) return;
      reportedTerminal.current.add(key);
      try {
        Sentry.captureException(
          new AuthHandoffError("Session recovery failed", status ?? 503),
          {
            tags: {
              area: "auth",
              operation: "complete",
              outcome,
              failure_stage: stage,
            },
            extra: { attempt, http_status: status },
            fingerprint: ["auth", "complete", stage, outcome],
          },
        );
      } catch {
        /* Telemetry cannot affect recovery. */
      }
    };
    const restore = async () => {
      try {
        // Grants are single-use. Recovery checks the session; it never repeats the exchange.
        const outcome = await withTransientAuthRetry(async () => {
          const result = await centralAuth.tokenManager.getTokenOutcome({
            forceRefresh: true,
          });
          if (result.state === "unavailable")
            throw new AuthHandoffError("بازیابی حساب موقتاً ممکن نیست.", 503);
          return result;
        });
        if (!isCurrent() || outcome.state === "invalidated") return;
        if (outcome.state === "unauthenticated") {
          confirmedSessionLoss = true;
          throw new AuthHandoffError("نشست فعال یافت نشد", 401);
        }
        stage = "self";
        const me = await withTransientAuthRetry(() => UserService.me(true));
        if (!isCurrent()) return;

        if (!me.isAdmin) {
          await withTransientAuthRetry(() => updateRouteHint("DELETE"));
          if (isCurrent())
            window.location.replace(
              new URL("/account", storefrontOrigin()).toString(),
            );
          return;
        }

        stage = "route_hint";
        await withTransientAuthRetry(() => updateRouteHint("PUT"));
        if (!isCurrent()) return;
        jotaiStore.set(currentUserAtom, me);
        jotaiStore.set(userLoadingAtom, false);
        jotaiStore.set(userErrorAtom, null);
        logDiagnostic("auth.recovery", {
          operation: "complete",
          outcome: "recovered",
          retry_count: attempt,
        });
        const destination =
          returnPath !== "/"
            ? returnPath
            : getAdminLandingPath(me.capabilities, me.adminRole);
        window.location.replace(destination);
      } catch (cause) {
        if (!isCurrent()) return;
        if (authErrorStatus(cause) === 401 && !confirmedSessionLoss) {
          const outcome = await centralAuth.tokenManager.getTokenOutcome({
            forceRefresh: true,
          });
          if (!isCurrent() || outcome.state === "invalidated") return;
          confirmedSessionLoss = outcome.state === "unauthenticated";
          if (!confirmedSessionLoss) {
            reportTerminal("unavailable", authErrorStatus(cause));
            logDiagnostic("auth.recovery", {
              operation: "complete",
              outcome: "unavailable",
              retry_count: attempt,
            });
            setFatal("بازیابی حساب موقتاً ممکن نیست. دوباره تلاش کنید.");
            return;
          }
        }
        logDiagnostic("auth.recovery", {
          retry_count: attempt,
          operation: "complete",
          outcome:
            authErrorStatus(cause) === 401 ? "unauthenticated" : "unavailable",
          http_status: authErrorStatus(cause),
        });
        if (authErrorStatus(cause) !== 401) {
          reportTerminal("unavailable", authErrorStatus(cause));
          setFatal("بازیابی حساب موقتاً ممکن نیست. دوباره تلاش کنید.");
          return;
        }
        centralAuth.tokenManager.expire();
        if (attempt >= 2) {
          reportTerminal("exhausted", 401);
          setFatal("بازیابی نشست ناموفق بود. دوباره وارد شوید.");
          return;
        }
        try {
          stage = "route_hint";
          await updateRouteHint("POST");
        } catch {
          if (!isCurrent()) return;
          reportTerminal("unavailable");
          setFatal("بازیابی حساب موقتاً ممکن نیست. دوباره تلاش کنید.");
          return;
        }
        if (!isCurrent()) return;
        const login = new URL("/auth", centralAuthOrigin);
        login.searchParams.set(
          "returnTo",
          new URL(returnPath, adminOrigin()).toString(),
        );
        window.location.replace(login.toString());
      }
    };
    void restore();
    return () => {
      active = false;
      if (started.current === runKey) started.current = null;
    };
  }, [attempt, callbackError, retryKey, returnPath]);

  return (
    <main
      className="flex min-h-[60vh] items-center justify-center p-6"
      dir="rtl"
    >
      <div
        className="max-w-md rounded-prominent border bg-white p-8 text-center"
        role={fatal ? "alert" : "status"}
      >
        {fatal ? (
          <>
            <p className="text-red-700">{fatal}</p>
            <button
              type="button"
              className="mt-4 rounded-full bg-infinity-primary px-5 py-2 text-white"
              onClick={() => setRetryKey((value) => value + 1)}
            >
              تلاش دوباره
            </button>
            <a
              className="mt-4 inline-block text-infinity-primary underline"
              href={storefrontOrigin()}
            >
              بازگشت
            </a>
          </>
        ) : (
          <p>در حال بازیابی حساب کاربری...</p>
        )}
      </div>
    </main>
  );
}
