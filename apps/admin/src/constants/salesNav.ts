import {
  capabilitiesForRole,
  normalizeAdminRole,
  type AdminCapability,
  type AdminRoleId,
} from "@repo/auth-core";
import {
  canCapabilitiesAccessPath,
  canRoleAccessPath,
} from "@/constants/roleAccess";

export type SalesNavItem = {
  id: string;
  label: string;
  href: string;
};

/**
 * The گزارشات (Reports) workspace.
 *
 * Primary sales navigation. Older report destinations remain routable through
 * the redirects in `next.config.ts`, but no longer compete with the core
 * overview/products/breakdown/behavior/liquidity workflow.
 *
 * Carts are an operational commerce surface and intentionally live below the
 * Orders item in the sidebar, not in this analytics nav.
 */
export const SALES_NAV_ITEMS: SalesNavItem[] = [
  { id: "sales-overview", label: "نمای کلی", href: "/sales" },
  { id: "sales-products", label: "فروش محصولات", href: "/sales/products" },
  { id: "sales-breakdown", label: "تفکیک فروش", href: "/sales/breakdown" },
  { id: "sales-traffic", label: "رفتار کاربران", href: "/sales/traffic" },
  { id: "sales-liquidity", label: "نقدینگی", href: "/sales/liquidity" },
];

/**
 * Role-filtered Sales navigation.
 *
 * Derived from `canRoleAccessPath` rather than a second hand-maintained id
 * list, so the sidebar, the in-page sub-navigation and the route guard cannot
 * drift apart and show a role a tab whose endpoint will 403.
 */
export const getSalesNavForRole = (roleName?: string | null): SalesNavItem[] =>
  SALES_NAV_ITEMS.filter((item) => canRoleAccessPath(roleName, item.href));

export const getSalesNavForCapabilities = (
  capabilities: readonly AdminCapability[] | null | undefined,
  role?: AdminRoleId | string | null,
): SalesNavItem[] =>
  SALES_NAV_ITEMS.filter((item) =>
    canCapabilitiesAccessPath(capabilities, item.href, role),
  );

export const getSalesNavForAdminRole = (
  role?: string | null,
): SalesNavItem[] => {
  const normalized = normalizeAdminRole(role);
  return getSalesNavForCapabilities(
    capabilitiesForRole(normalized),
    normalized,
  );
};
