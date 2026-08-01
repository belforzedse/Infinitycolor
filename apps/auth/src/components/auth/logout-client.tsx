"use client";

import { useEffect, useRef, useState } from "react";
import { authPost } from "./auth-api";

export function LogoutClient({ callbackUrl }: { callbackUrl: string }) {
  const started = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    authPost("/sign-out")
      .catch(() => setFailed(true))
      .then(() => authPost("/infinity/flow/clear").catch(() => undefined))
      .finally(() => window.location.replace(callbackUrl));
  }, [callbackUrl]);
  return (
    <div className="text-center" role="status">
      {failed
        ? "خروج محلی در حال تکمیل است..."
        : "در حال خروج از حساب کاربری..."}
    </div>
  );
}
