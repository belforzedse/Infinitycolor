"use client";

import { useEffect, useRef } from "react";
import { jotaiStore } from "@/lib/jotaiStore";
import { currentUserAtom, userErrorAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { clearCentralAuthForLogout, initializeCentralAuthBrowser } from "@/lib/central-auth";
import { clearUserStorage } from "@/utils/userStorage";
import { __clearOrderCache } from "@/services/order";
import { invalidateAddressCache } from "@/services/user/addresses";

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
    __clearOrderCache();
    invalidateAddressCache();
    clearUserStorage();
    window.location.replace("/");
  }, []);
  return (
    <main className="flex min-h-[60vh] items-center justify-center" role="status">
      در حال تکمیل خروج...
    </main>
  );
}
