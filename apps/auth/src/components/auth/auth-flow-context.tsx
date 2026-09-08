"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { authPost } from "./auth-api";

interface AuthFlowContextValue {
  phone: string;
  flowReady: boolean;
  setPhone(phone: string): void;
  href(path: string): string;
  go(path: string): void;
}

const AuthFlowContext = createContext<AuthFlowContextValue | null>(null);

export function AuthFlowProvider({ children }: { children: React.ReactNode }) {
  const [phone, setPhone] = useState("");
  const [flowReady, setFlowReady] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("returnTo");

  useEffect(() => {
    let active = true;
    authPost<{ phone: string | null }>("/infinity/flow/start", { returnTo })
      .then(async (flow) => {
        if (!active) return;
        if (flow.phone) setPhone(flow.phone);
        if (pathname !== "/auth") return;
        try {
          const continuation = await authPost<{
            authenticated: true;
            redirectTo: string;
          }>("/infinity/session/continue");
          if (active) window.location.replace(continuation.redirectTo);
        } catch {
          // No reusable central session: reveal the normal credential flow.
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setFlowReady(true);
      });
    return () => {
      active = false;
    };
  }, [pathname, returnTo]);

  const href = useCallback(
    (path: string) => {
      if (!returnTo) return path;
      const separator = path.includes("?") ? "&" : "?";
      return `${path}${separator}returnTo=${encodeURIComponent(returnTo)}`;
    },
    [returnTo],
  );
  const go = useCallback(
    (path: string) => router.push(href(path)),
    [href, router],
  );
  const value = useMemo(
    () => ({ phone, flowReady, setPhone, href, go }),
    [phone, flowReady, href, go],
  );

  return (
    <AuthFlowContext.Provider value={value}>
      {children}
    </AuthFlowContext.Provider>
  );
}

export function useAuthFlow(): AuthFlowContextValue {
  const value = useContext(AuthFlowContext);
  if (!value)
    throw new Error("useAuthFlow must be used inside AuthFlowProvider");
  return value;
}
