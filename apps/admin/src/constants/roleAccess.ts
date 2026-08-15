import {
  capabilitiesForRole,
  hasCapability,
  normalizeAdminRole,
  type AdminCapability,
  type AdminRoleId,
} from "@repo/auth-core";

type AdminRouteRule = Readonly<{
  prefix: string;
  capability: AdminCapability | null;
  exact?: boolean;
}>;

/**
 * Registered admin routes. Rules are ordered from most specific to least
 * specific. Unknown paths deny every non-Superadmin role by default.
 */
export const ADMIN_ROUTE_RULES: readonly AdminRouteRule[] = [
  { prefix: "/account", capability: "account.self.read" },
  { prefix: "/orders/add", capability: "order.manual.create" },
  { prefix: "/orders/print", capability: "order.print" },
  { prefix: "/orders/anipo-barcode", capability: "order.print" },
  { prefix: "/orders/carts", capability: "report.carts.read" },
  { prefix: "/orders", capability: "order.read" },
  {
    prefix: "/products/homepage-custom-section",
    capability: "system.customization.manage",
  },
  { prefix: "/products/homepage", capability: "system.customization.manage" },
  { prefix: "/products/gif-promo", capability: "system.customization.manage" },
  { prefix: "/products/comments", capability: "system.reviews.manage" },
  { prefix: "/products/size-guide", capability: "product.size-guide.manage" },
  { prefix: "/products/colors", capability: "product.variation.manage" },
  { prefix: "/products/attributes", capability: "product.variation.manage" },
  { prefix: "/products/tags", capability: "product.update" },
  { prefix: "/products/categories", capability: "category.read" },
  { prefix: "/products/add", capability: "product.create" },
  { prefix: "/products", capability: "product.read" },
  { prefix: "/blog", capability: "content.blog.read" },
  { prefix: "/stories", capability: "content.stories.manage" },
  { prefix: "/faq", capability: "content.faq.manage" },
  { prefix: "/sales/traffic", capability: "report.traffic.read" },
  { prefix: "/sales/funnel", capability: "report.traffic.read" },
  { prefix: "/sales/carts", capability: "report.carts.read" },
  { prefix: "/sales/liquidity", capability: "report.finance.read" },
  { prefix: "/sales/gateways", capability: "report.finance.read" },
  { prefix: "/sales/products", capability: "report.product.read" },
  { prefix: "/sales", capability: "report.sales.read" },
  { prefix: "/reports/traffic", capability: "report.traffic.read" },
  { prefix: "/reports/liquidity", capability: "report.finance.read" },
  { prefix: "/reports/gateway-liquidity", capability: "report.finance.read" },
  { prefix: "/reports/admin-activity", capability: "system.audit.read" },
  { prefix: "/reports", capability: "report.sales.read" },
  { prefix: "/carts", capability: "report.carts.read" },
  { prefix: "/wallets", capability: "wallet.read" },
  { prefix: "/users", capability: "system.users.manage" },
  { prefix: "/settings/activity", capability: "system.audit.read" },
  { prefix: "/settings", capability: "system.settings.manage" },
  { prefix: "/customization", capability: "system.customization.manage" },
  { prefix: "/coupons", capability: "system.discounts.manage" },
  { prefix: "/general-discounts", capability: "system.discounts.manage" },
  { prefix: "/shipping", capability: "system.shipping.manage" },
  { prefix: "/payment-methods", capability: "system.payments.manage" },
  { prefix: "/purgeall", capability: "system.purge.execute" },
  { prefix: "/", capability: null, exact: true },
];

const matchesRule = (pathname: string, rule: AdminRouteRule): boolean =>
  rule.exact
    ? pathname === rule.prefix
    : pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`);

export function canCapabilitiesAccessPath(
  capabilities: readonly AdminCapability[] | null | undefined,
  pathname?: string | null,
  role?: AdminRoleId | string | null,
): boolean {
  const adminRole = normalizeAdminRole(role);
  if (!adminRole || !pathname) return false;
  if (adminRole === "superadmin") return true;
  const rule = ADMIN_ROUTE_RULES.find((candidate) =>
    matchesRule(pathname, candidate),
  );
  if (!rule) return false;
  if (rule.capability === null) return true;
  return (capabilities ?? []).includes(rule.capability);
}

export function getAdminLandingPath(
  capabilities: readonly AdminCapability[] | null | undefined,
  role?: AdminRoleId | string | null,
): string {
  const adminRole = normalizeAdminRole(role);
  const preferredByRole: Partial<Record<AdminRoleId, string>> = {
    editor: "/blog",
    seller1: "/products",
    seller2: "/products",
    store_manager: "/orders",
    store_manager_2: "/orders",
    finance: "/sales",
    founder: "/",
    superadmin: "/",
  };
  const candidates = [
    adminRole ? preferredByRole[adminRole] : null,
    "/",
    "/blog",
    "/products",
    "/orders",
    "/sales",
    "/account",
  ].filter((value): value is string => Boolean(value));
  return (
    candidates.find((candidate) =>
      canCapabilitiesAccessPath(capabilities, candidate, adminRole),
    ) ?? "/account"
  );
}

/** Compatibility helpers for remaining call sites while the UI migrates. */
export const canRoleAccessPath = (
  roleName?: string | null,
  pathname?: string | null,
): boolean => {
  const role = normalizeAdminRole(roleName);
  return canCapabilitiesAccessPath(capabilitiesForRole(role), pathname, role);
};

export const getRoleAdminLandingPath = (roleName?: string | null): string => {
  const role = normalizeAdminRole(roleName);
  return getAdminLandingPath(capabilitiesForRole(role), role);
};

export const isFounderRole = (roleName?: string | null): boolean =>
  normalizeAdminRole(roleName) === "founder";
export const isStoreManagerRole = (roleName?: string | null): boolean =>
  ["store_manager", "store_manager_2"].includes(
    normalizeAdminRole(roleName) ?? "",
  );
export const isEditorRole = (roleName?: string | null): boolean =>
  normalizeAdminRole(roleName) === "editor";

export { hasCapability };
