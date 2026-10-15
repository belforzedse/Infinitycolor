"use client";

import { useEffect, useState, type ReactNode } from "react";
import { UserService } from "@/services";
import { readAuthStateVersion, subscribeToAuthState } from "@/lib/central-auth";

/** A print tab opens outside the admin shell and must load its own permissions. */
export default function OrderPrintPermissionGate({
  children,
}: {
  children: ReactNode;
}) {
  const [status, setStatus] = useState<
    "loading" | "allowed" | "denied" | "error"
  >("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let operation = 0;
    const check = async () => {
      const request = ++operation;
      const version = readAuthStateVersion();
      const current = () =>
        active && request === operation && version === readAuthStateVersion();
      setStatus("loading");
      try {
        const user = await UserService.me(true);
        if (current())
          setStatus(
            user.capabilities?.includes("order.print") ? "allowed" : "denied",
          );
      } catch {
        if (current()) setStatus("error");
      }
    };
    void check();
    const unsubscribe = subscribeToAuthState(() => {
      void check();
    });
    return () => {
      active = false;
      operation += 1;
      unsubscribe();
    };
  }, [attempt]);
  if (status === "loading")
    return <div className="anipo-loading">در حال بارگذاری…</div>;
  if (status === "denied")
    return <div className="anipo-loading">دسترسی چاپ ندارید</div>;
  if (status === "error")
    return (
      <div className="anipo-loading">
        <p>دریافت دسترسی چاپ انجام نشد</p>
        <button
          type="button"
          className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm"
          onClick={() => setAttempt((value) => value + 1)}
        >
          تلاش دوباره
        </button>
      </div>
    );
  return children;
}
