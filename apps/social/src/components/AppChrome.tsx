"use client";

import { Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { MobileBottomNav } from "@/components/MobileBottomNav";

function PathnameAwareChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuth = pathname.startsWith("/auth");

  return (
    <>
      <div className={isAuth ? "min-h-dvh" : "min-h-dvh pb-28 lg:pb-0"}>{children}</div>
      {!isAuth ? <MobileBottomNav /> : null}
    </>
  );
}

export function AppChrome({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-dvh pb-28 lg:pb-0">{children}</div>}>
      <PathnameAwareChrome>{children}</PathnameAwareChrome>
    </Suspense>
  );
}
