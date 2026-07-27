"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useRef } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    Sentry.withScope((scope) => {
      scope.setTag("recovery_surface", "root-layout");
      if (error.digest) scope.setTag("next_error_digest", error.digest);
      Sentry.captureException(error);
    });
  }, [error]);

  return (
    <html lang="fa" dir="rtl">
      <body style={{ margin: 0, background: "#f8fafc", color: "#0f172a" }}>
        <main
          role="alert"
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <section
            style={{
              width: "100%",
              maxWidth: "560px",
              padding: "32px",
              border: "1px solid #e2e8f0",
              borderRadius: "24px",
              background: "#ffffff",
              textAlign: "center",
              boxSizing: "border-box",
            }}
          >
            <h1 ref={headingRef} tabIndex={-1} style={{ margin: 0, fontSize: "24px" }}>
              راه‌اندازی صفحه کامل نشد
            </h1>
            <p style={{ margin: "16px 0 24px", lineHeight: 1.9, color: "#475569" }}>
              هیچ تغییری از دست نرفته است. دوباره تلاش کنید یا به فروشگاه برگردید.
            </p>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: "12px",
              }}
            >
              <button
                type="button"
                onClick={reset}
                style={{
                  minHeight: "44px",
                  border: 0,
                  borderRadius: "12px",
                  padding: "10px 20px",
                  background: "#3d4c6e",
                  color: "#ffffff",
                  cursor: "pointer",
                }}
              >
                تلاش دوباره
              </button>
              <a
                href="/"
                style={{
                  minHeight: "44px",
                  display: "inline-flex",
                  alignItems: "center",
                  border: "1px solid #cbd5e1",
                  borderRadius: "12px",
                  padding: "0 20px",
                  color: "#334155",
                  textDecoration: "none",
                  boxSizing: "border-box",
                }}
              >
                بازگشت به فروشگاه
              </a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
