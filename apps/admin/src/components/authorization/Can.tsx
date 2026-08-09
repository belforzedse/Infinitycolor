"use client";

import type { AdminCapability } from "@repo/auth-core";
import type { ReactNode } from "react";
import { useCan } from "@/hooks/useCan";

export function Can({
  capability,
  children,
  fallback = null,
}: {
  capability: AdminCapability;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useCan(capability) ? children : fallback;
}
