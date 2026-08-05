"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("returnTo");

  useEffect(() => {
    let active = true;
    authPost<{ phone: string | null }>("/infinity/flow/start", { returnTo })
      .then((flow) => {
        if (active && flow.phone) setPhone(flow.phone);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setFlowReady(true);
      });
    return () => {
      active = false;
    };
  }, [returnTo]);

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
