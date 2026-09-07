"use client";

import { useEffect, useRef } from "react";
import { jotaiStore } from "@/lib/jotaiStore";
import { currentUserAtom, userErrorAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { clearCentralAuthForLogout, initializeCentralAuthBrowser } from "@/lib/central-auth";
import { clearAllCommentDrafts } from "@/lib/offline-snapshots";

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
    clearAllCommentDrafts();
    window.location.replace("/");
  }, []);
  return (
    <main className="flex min-h-[60vh] items-center justify-center" role="status">
      در حال تکمیل خروج...
    </main>
  );
}
