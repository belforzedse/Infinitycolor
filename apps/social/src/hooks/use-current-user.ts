"use client";

import { useAtomValue } from "jotai";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";

const SUPER_ADMIN_ROLE = "superadmin";
const STORE_MANAGER_ROLE = "store manager";

/**
 * Session probe + first name + role flags for UI.
 * Relies on `AuthInitializer` to restore the in-memory bearer and `/auth/self`.
 */
export function useCurrentUser() {
  const user = useAtomValue(currentUserAtom);
  const isLoading = useAtomValue(userLoadingAtom);
  const firstName = typeof user?.FirstName === "string" ? user.FirstName : null;
  const roleName = typeof user?.roleName === "string" ? user.roleName : null;
  const normalizedRole = (roleName ?? "").toLowerCase().trim();
  const isSuperAdmin = normalizedRole === SUPER_ADMIN_ROLE;
  const isStoreManager = normalizedRole === STORE_MANAGER_ROLE;

  return {
    isLoading,
    isAuthenticated: Boolean(user),
    firstName,
    roleName,
    isAdmin: user?.isAdmin === true,
    isSuperAdmin,
    isStoreManager,
    canCreatePost: isSuperAdmin || isStoreManager,
  };
}
