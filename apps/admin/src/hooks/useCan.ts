"use client";

import type { AdminCapability } from "@repo/auth-core";
import { useCurrentUser } from "./useCurrentUser";

export function useCan(capability: AdminCapability): boolean {
  const { capabilities } = useCurrentUser();
  return capabilities.includes(capability);
}
