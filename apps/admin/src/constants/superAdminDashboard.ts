import type { AdminCapability } from "@repo/auth-core";
import { storefrontOrigin } from "@/config/admin-env";

export const DASHBOARD_USER_ACTION_HREF = "/users";

export const DASHBOARD_QUICK_ACTIONS: readonly {
  href: string;
  label: string;
  capability: AdminCapability;
}[] = [
  { href: "/blog", label: "مدیریت وبلاگ", capability: "content.blog.read" },
  { href: "/products", label: "مدیریت محصولات", capability: "product.read" },
  { href: "/orders", label: "پیگیری سفارش‌ها", capability: "order.read" },
  { href: storefrontOrigin(), label: "ورود به فروشگاه", capability: "storefront.checkout.use" },
  { href: "/orders/add", label: "افزودن سفارش", capability: "order.manual.create" },
  { href: "/sales/products", label: "گزارش محصولات", capability: "report.product.read" },
  { href: "/sales", label: "گزارشات مالی و فروش", capability: "report.finance.read" },
  { href: "/sales/traffic", label: "تحلیل ترافیک", capability: "report.traffic.read" },
  { href: "/wallets", label: "مدیریت کیف پول", capability: "wallet.read" },
  { href: DASHBOARD_USER_ACTION_HREF, label: "کاربران", capability: "system.users.manage" },
];

export const canSeeDashboardUserMetric = (
  capabilities: readonly AdminCapability[] | null | undefined,
): boolean => Boolean(capabilities?.includes("system.users.manage"));

export const getDashboardQuickActions = (
  capabilities: readonly AdminCapability[] | null | undefined,
) => DASHBOARD_QUICK_ACTIONS.filter((action) => capabilities?.includes(action.capability));
