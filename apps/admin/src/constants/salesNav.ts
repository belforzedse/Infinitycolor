import { capabilitiesForRole, normalizeAdminRole, type AdminCapability, type AdminRoleId } from "@repo/auth-core";
import { canCapabilitiesAccessPath, canRoleAccessPath } from "@/constants/roleAccess";

export type SalesNavItem = {
  id: string;
  label: string;
  href: string;
};

/**
 * The گزارشات (Reports) workspace.
 *
 * These destinations previously sat in a `reports` sidebar group that had no
 * `href`, which made `/reports` itself unreachable — and `/reports` was the
 * only inbound link to the liquidity and gateway-liquidity pages, so both were
 * dead in the navigation despite working.
 *
 * Order is deliberate: the overview lands first, then the analytical cuts of
 * "how are we selling", then the money-movement reports, then the pre-purchase
 * surfaces (traffic, carts), then the non-sales admin audit report.
 *
 * `sales-activity` intentionally points at `/settings/activity`, not a
 * `/sales/*` path — the audit log's own page/route did not move, only its
 * entry point did. Founder access is still narrowed automatically:
 * `getSalesNavForRole` filters every item through `canRoleAccessPath`, and
 * `/settings` is already in `FOUNDER_FORBIDDEN_PREFIXES`.
 */
export const SALES_NAV_ITEMS: SalesNavItem[] = [
  { id: "sales-overview", label: "نمای کلی", href: "/sales" },
  { id: "sales-breakdown", label: "تفکیک فروش", href: "/sales/breakdown" },
  { id: "sales-products", label: "فروش محصولات", href: "/sales/products" },
  { id: "sales-funnel", label: "قیف فروش", href: "/sales/funnel" },
  { id: "sales-geography", label: "فروش جغرافیایی", href: "/sales/geography" },
  { id: "sales-liquidity", label: "نقدینگی", href: "/sales/liquidity" },
  { id: "sales-gateways", label: "نقدینگی درگاه‌ها", href: "/sales/gateways" },
  { id: "sales-traffic", label: "تحلیل ترافیک", href: "/sales/traffic" },
  { id: "sales-carts", label: "سبدهای خرید", href: "/sales/carts" },
  { id: "sales-activity", label: "گزارش فعالیت ادمین‌ها", href: "/settings/activity" },
];

/**
 * Role-filtered Sales navigation.
 *
 * Derived from `canRoleAccessPath` rather than a second hand-maintained id
 * list, so the sidebar, the in-page sub-navigation and the route guard cannot
 * drift apart and show a role a tab whose endpoint will 403.
 */
export const getSalesNavForRole = (
  roleName?: string | null,
): SalesNavItem[] =>
  SALES_NAV_ITEMS.filter((item) => canRoleAccessPath(roleName, item.href));

export const getSalesNavForCapabilities = (
  capabilities: readonly AdminCapability[] | null | undefined,
  role?: AdminRoleId | string | null,
): SalesNavItem[] =>
  SALES_NAV_ITEMS.filter((item) =>
    canCapabilitiesAccessPath(capabilities, item.href, role),
  );

export const getSalesNavForAdminRole = (role?: string | null): SalesNavItem[] => {
  const normalized = normalizeAdminRole(role);
  return getSalesNavForCapabilities(capabilitiesForRole(normalized), normalized);
};
