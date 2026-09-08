"use client";

import { useEffect } from "react";
import { centralAuthOrigin } from "@/lib/central-auth";

export default function PasswordPage() {
  useEffect(() => {
    const target = new URL("/auth/forgot-password", centralAuthOrigin);
    target.searchParams.set("returnTo", new URL("/account", window.location.origin).toString());
    window.location.replace(target.toString());
  }, []);

  return <p role="status" className="p-6 text-center">در حال انتقال…</p>;
}
