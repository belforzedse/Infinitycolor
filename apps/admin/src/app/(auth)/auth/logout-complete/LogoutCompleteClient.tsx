"use client";

import { useEffect, useRef } from "react";
import { clearCentralAuthForLogout, initializeCentralAuthBrowser } from "@/lib/central-auth";
import { currentUserAtom, userErrorAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { jotaiStore } from "@/lib/jotaiStore";
import { storefrontOrigin } from "@/config/admin-env";

export default function LogoutCompleteClient() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    initializeCentralAuthBrowser();
    clearCentralAuthForLogout();
    jotaiStore.set(currentUserAtom, null);
    jotaiStore.set(userLoadingAtom, false);
    jotaiStore.set(userErrorAtom, null);
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_ADMIN_CACHES" });
    window.location.replace(storefrontOrigin());
  }, []);
  return <main className="flex min-h-screen items-center justify-center" role="status">در حال تکمیل خروج...</main>;
}
