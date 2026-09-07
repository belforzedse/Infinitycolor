"use client";

import { useEffect, useRef, useState } from "react";
import { jotaiStore } from "@/lib/jotaiStore";
import { currentUserAtom, userErrorAtom, userLoadingAtom } from "@/lib/atoms/auth";
import {
  centralAuth,
  centralAuthOrigin,
  initializeCentralAuthBrowser,
  publishAuthState,
} from "@/lib/central-auth";
import UserService from "@/services/user";
import { isProfileIncomplete } from "@/utils/profile";

export default function AuthCompleteClient({
  returnPath,
  attempt,
  callbackError,
}: {
  returnPath: string;
  attempt: number;
  callbackError?: string;
}) {
  const started = useRef(false);
  const [fatal, setFatal] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const restore = async () => {
      try {
        if (callbackError) throw new Error("مجوز بازگشت معتبر نیست. دوباره وارد شوید.");
        initializeCentralAuthBrowser();
        const token = await centralAuth.tokenManager.getToken({ forceRefresh: true });
        if (!token) throw new Error("نشست فعال یافت نشد");
        const me = await UserService.me();
        jotaiStore.set(currentUserAtom, me);
        jotaiStore.set(userLoadingAtom, false);
        jotaiStore.set(userErrorAtom, null);

        if (!me.isAdmin && isProfileIncomplete(me)) {
          const url = new URL("/auth/register/info", centralAuthOrigin);
          url.searchParams.set("returnTo", new URL(returnPath, window.location.origin).toString());
          window.location.replace(url.toString());
          return;
        }

        publishAuthState("session-changed");
        await fetch("/api/auth/route-hint", { method: "PUT", credentials: "same-origin" });
        window.location.replace(returnPath !== "/" ? returnPath : "/profile");
      } catch (cause) {
        centralAuth.tokenManager.expire();
        await fetch("/api/auth/route-hint", { method: "POST", credentials: "same-origin" }).catch(
          () => undefined,
        );
        if (attempt >= 2) {
          setFatal(cause instanceof Error ? cause.message : "بازیابی نشست ناموفق بود");
          return;
        }
        const login = new URL("/auth", centralAuthOrigin);
        login.searchParams.set("returnTo", new URL(returnPath, window.location.origin).toString());
        window.location.replace(login.toString());
      }
    };
    void restore();
  }, [attempt, callbackError, returnPath]);

  return (
    <main className="flex min-h-[60vh] items-center justify-center p-6" dir="rtl">
      <div className="max-w-md rounded-3xl border bg-white p-8 text-center" role={fatal ? "alert" : "status"}>
        {fatal ? (
          <>
            <p className="text-red-700">{fatal}</p>
            <a className="mt-4 inline-block text-infinity-primary underline" href="/">
              بازگشت به اینفینیتی‌گرام
            </a>
          </>
        ) : (
          <p>در حال بازیابی حساب کاربری...</p>
        )}
      </div>
    </main>
  );
}
