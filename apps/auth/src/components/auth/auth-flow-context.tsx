"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AuthApiError, authPost } from "./auth-api";
import {
  authBootstrapAction,
  classifyBootstrapFailure,
} from "./auth-flow-bootstrap";

interface AuthFlowContextValue {
  phone: string;
  passwordReset: boolean;
  setPasswordReset(value: boolean): void;
  flowReady: boolean;
  setPhone(phone: string): void;
  acceptStartedFlow(phone: string): void;
  markSessionAbsent(): void;
  href(path: string): string;
  go(path: string): void;
}

const AuthFlowContext = createContext<AuthFlowContextValue | null>(null);

export function AuthFlowProvider({
  children,
  hasSessionCookie,
}: {
  children: React.ReactNode;
  hasSessionCookie: boolean;
}) {
  const [phone, setPhone] = useState("");
  const [passwordReset, setPasswordReset] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const stepUp = searchParams.get("stepUp") === "1";
  const flowInitialized = useRef(false);
  const sessionKnownAbsent = useRef(!hasSessionCookie || stepUp);
  const pendingBootstrap = useRef<{
    key: string;
    promise: Promise<"ready" | "redirect" | "retry">;
  } | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const initialAction = authBootstrapAction({
    pathname,
    hasSessionCookie,
    stepUp,
    flowInitialized: false,
    sessionKnownAbsent: sessionKnownAbsent.current,
  });
  const [bootstrapState, setBootstrapState] = useState<
    "ready" | "loading" | "retry"
  >(initialAction === "none" ? "ready" : "loading");

  useEffect(() => {
    if (stepUp) sessionKnownAbsent.current = true;
    const action = authBootstrapAction({
      pathname,
      hasSessionCookie,
      stepUp,
      flowInitialized: flowInitialized.current,
      sessionKnownAbsent: sessionKnownAbsent.current,
    });
    if (action === "none") {
      setBootstrapState("ready");
      return;
    }

    let active = true;
    setBootstrapState("loading");
    const key = `${action}:${pathname}:${returnTo ?? ""}:${retryVersion}`;
    let operation = pendingBootstrap.current;
    if (!operation || operation.key !== key) {
      const run = async (): Promise<"ready" | "redirect" | "retry"> => {
        let flow: { phone: string | null };
        try {
          flow = await authPost<{ phone: string | null }>(
            "/infinity/flow/start",
            { returnTo },
          );
          flowInitialized.current = true;
          if (flow.phone) setPhone(flow.phone);
        } catch (cause) {
          const status = cause instanceof AuthApiError ? cause.status : 0;
          return classifyBootstrapFailure("flow", status);
        }
        if (action === "hydrate-flow") return "ready";

        try {
          const continuation = await authPost<{
            authenticated: true;
            redirectTo: string;
          }>("/infinity/session/continue");
          window.location.replace(continuation.redirectTo);
          return "redirect";
        } catch (cause) {
          const status = cause instanceof AuthApiError ? cause.status : 0;
          if (
            classifyBootstrapFailure("continuation", status) === "credentials"
          ) {
            sessionKnownAbsent.current = true;
            return "ready";
          }
          return "retry";
        }
      };
      operation = { key, promise: run() };
      pendingBootstrap.current = operation;
      void operation.promise.finally(() => {
        if (pendingBootstrap.current?.key === key)
          pendingBootstrap.current = null;
      });
    }
    void operation.promise.then((result) => {
      if (!active || result === "redirect") return;
      setBootstrapState(result);
    });
    return () => {
      active = false;
    };
  }, [hasSessionCookie, pathname, retryVersion, returnTo, stepUp]);

  const acceptStartedFlow = useCallback((acceptedPhone: string) => {
    flowInitialized.current = true;
    sessionKnownAbsent.current = true;
    setPhone(acceptedPhone);
    setBootstrapState("ready");
  }, []);
  const markSessionAbsent = useCallback(() => {
    sessionKnownAbsent.current = true;
  }, []);

  const href = useCallback(
    (path: string) => {
      const url = new URL(path, "https://auth.invalid");
      if (returnTo) url.searchParams.set("returnTo", returnTo);
      if (stepUp) url.searchParams.set("stepUp", "1");
      return `${url.pathname}${url.search}`;
    },
    [returnTo, stepUp],
  );
  const go = useCallback(
    (path: string) => router.push(href(path)),
    [href, router],
  );
  const value = useMemo(
    () => ({
      phone,
      flowReady: bootstrapState === "ready",
      setPhone,
      acceptStartedFlow,
      markSessionAbsent,
      href,
      go,
      passwordReset,
      setPasswordReset,
    }),
    [
      phone,
      bootstrapState,
      acceptStartedFlow,
      markSessionAbsent,
      href,
      go,
      passwordReset,
    ],
  );

  return (
    <AuthFlowContext.Provider value={value}>
      {bootstrapState === "ready" ? (
        children
      ) : (
        <div
          className="p-8 text-center"
          dir="rtl"
          role={bootstrapState === "retry" ? "alert" : "status"}
        >
          <p>
            {bootstrapState === "retry"
              ? "بررسی نشست موقتاً ممکن نیست. دوباره تلاش کنید."
              : "در حال بررسی نشست..."}
          </p>
          {bootstrapState === "retry" ? (
            <button
              type="button"
              className="mt-4 text-sm text-infinity-primary underline"
              onClick={() => setRetryVersion((value) => value + 1)}
            >
              تلاش دوباره
            </button>
          ) : null}
        </div>
      )}
    </AuthFlowContext.Provider>
  );
}

export function useAuthFlow(): AuthFlowContextValue {
  const value = useContext(AuthFlowContext);
  if (!value)
    throw new Error("useAuthFlow must be used inside AuthFlowProvider");
  return value;
}
