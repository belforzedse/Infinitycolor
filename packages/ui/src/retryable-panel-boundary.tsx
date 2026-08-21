"use client";

import { catchError, type ErrorInfo } from "next/error";
import type { ReactNode } from "react";

type BoundaryProps = { label: string };

const Boundary = catchError<BoundaryProps>(({ label }, { retry }: ErrorInfo) => (
  <section className="rounded-2xl border border-slate-200 bg-white p-6 text-center" role="alert">
    <p>{label} در دسترس نیست.</p>
    <button
      className="mt-3 rounded-full bg-slate-800 px-4 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      type="button"
      onClick={retry}
    >
      تلاش دوباره
    </button>
  </section>
));

export function RetryablePanelBoundary({
  children,
  label,
}: BoundaryProps & { children: ReactNode }) {
  return <Boundary label={label}>{children}</Boundary>;
}
