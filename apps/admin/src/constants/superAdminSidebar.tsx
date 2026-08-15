import type { ReactNode } from "react";
import { canCapabilitiesAccessPath } from "@/constants/roleAccess";
import { SALES_NAV_ITEMS } from "@/constants/salesNav";
import {
  capabilitiesForRole,
  normalizeAdminRole,
  type AdminCapability,
  type AdminRoleId,
} from "@repo/auth-core";
import ProductIcon from "@/components/SuperAdmin/Layout/Icons/ProductIcon";
import OrdersIcon from "@/components/SuperAdmin/Layout/Icons/OrdersIcon";
import UsersIcon from "@/components/SuperAdmin/Layout/Icons/UsersIcon";
import CartIcon from "@/components/SuperAdmin/Layout/Icons/CartIcon";
import ShippingIcon from "@/components/SuperAdmin/Layout/Icons/ShippingIcon";
import PercentIcon from "@/components/SuperAdmin/Layout/Icons/PercentIcon";
import DashboardIcon from "@/components/SuperAdmin/Layout/Icons/DashboardIcon";
import PaymentIcon from "@/components/SuperAdmin/Layout/Icons/PaymentIcon";
import BlogIcon from "@/components/SuperAdmin/Layout/Icons/BlogIcon";
import FAQIcon from "@/components/SuperAdmin/Layout/Icons/FAQIcon";
import SettingsIcon from "@/components/SuperAdmin/Layout/Icons/SettingsIcon";
import {
  //FiLayout,
  FiMenu,
  FiUsers,
  FiLayers,
  FiBell,
  FiBarChart,
  FiDatabase,
  FiPlayCircle,
  FiSliders,
  FiBookOpen,
  FiFileText,
  FiFolder,
  FiImage,
  FiTag,
  FiUser,
  FiMessageCircle,
  FiDroplet,
  FiList,
} from "react-icons/fi";

// Create a styled layout/menu icons (unused definitions removed)
const RarMenu = () => (
  <FiMenu className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />
);
//Create a styled club icon
const _MultiUsersIcon = () => (
  <FiUsers className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />
);

//Create a styled Pages icon
const _PagesIcon = () => (
  <FiLayers className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />
);

const BellIcon = () => (
  <FiBell className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />
);
const ChartIcon = () => (
  <FiBarChart className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />
);

const _CacheIcon = () => (
  <FiDatabase className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />
);

type SidebarChild = {
  id: string;
  label: string;
  href: string;
  icon?: ReactNode;
};

export type SidebarItem = {
  id: string;
  label: string;
  href?: string;
  icon: ReactNode;
  children: SidebarChild[];
};

const superAdminSidebar: SidebarItem[] = [
  {
    id: "dashboard",
    label: "پیشخوان",
    href: "/",
    icon: <DashboardIcon />,
    children: [],
  },
  {
    id: "customization",
    label: "شخصی‌سازی",
    href: "/customization",
    icon: (
      <FiSliders className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />
    ),
    children: [
      {
        id: "customization-visual-identity",
        label: "هویت بصری",
        href: "/customization/visual-identity",
      },
      {
        id: "customization-personalization",
        label: "شخصی‌سازی",
        href: "/customization/personalization",
      },
    ],
  },
  {
    id: "manage-products",
    label: "مدیریت محصولات",
    href: "",
    icon: <ProductIcon />,

    children: [
      {
        id: "products",
        label: " محصولات",
        href: "/products",
        icon: <ProductIcon />,
      },
      {
        id: "homepage-products",
        label: "محصولات صفحه اصلی",
        href: "/products/homepage",
      },
      {
        id: "homepage-gif-promo-products",
        label: "محصولات کمپین گیف",
        href: "/products/gif-promo",
      },
      {
        id: "homepage-custom-section",
        label: "بخش ویژه صفحه اصلی",
        href: "/products/homepage-custom-section",
      },
      {
        id: "product-categories",
        label: "دسته بندی ها",
        href: "/products/categories",
        icon: <FiFolder className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "product-tags",
        label: "برچسب ها",
        href: "/products/tags",
        icon: <FiTag className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "product-comments",
        label: "مدیریت نظرات",
        href: "/products/comments",
      },
      {
        id: "product-colors",
        label: "مدیریت رنگ‌ها",
        href: "/products/colors",
        icon: <FiDroplet className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "product-attributes",
        label: "ویژگی ها",
        href: "/products/attributes",
        icon: <FiList className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "product-size-guide",
        label: "راهنمای سایز",
        href: "/products/size-guide",
        icon: <FiBookOpen className="h-5 w-5 text-infinity-primary" />,
      },
    ],
  },
  {
    id: "blog",
    label: "مدیریت وبلاگ",
    href: "",
    icon: <BlogIcon />,
    children: [
      {
        id: "blog-dashboard",
        label: "داشبورد وبلاگ",
        href: "/blog",
        icon: <FiBookOpen className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "blog-posts",
        label: "مدیریت پست‌ها",
        href: "/blog/posts",
        icon: <FiFileText className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "blog-categories",
        label: "دسته‌بندی‌ها",
        href: "/blog/categories",
        icon: <FiFolder className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "blog-category-banners",
        label: "بنر دسته‌بندی‌ها",
        href: "/blog/categories/banners",
        icon: <FiImage className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "blog-tags",
        label: "برچسب‌ها",
        href: "/blog/tags",
        icon: <FiTag className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "blog-authors",
        label: "نویسندگان",
        href: "/blog/authors",
        icon: <FiUser className="h-5 w-5 text-infinity-primary" />,
      },
      {
        id: "blog-comments",
        label: "مدیریت نظرات",
        href: "/blog/comments",
        icon: <FiMessageCircle className="h-5 w-5 text-infinity-primary" />,
      },
    ],
  },
  {
    id: "stories",
    label: "استوری‌ها",
    href: "/stories",
    icon: (
      <FiPlayCircle
        className="h-5 w-5 text-infinity-primary"
        stroke="#3d4c6e"
      />
    ),
    children: [
      {
        id: "stories-list",
        label: "لیست استوری‌ها",
        href: "/stories",
      },
      {
        id: "stories-add",
        label: "افزودن استوری",
        href: "/stories/add",
      },
    ],
  },
  {
    id: "faq",
    label: "سوالات متداول",
    href: "",
    icon: <FAQIcon />,
    children: [
      {
        id: "faq-categories",
        label: "دسته‌بندی‌ها",
        href: "/faq/categories",
      },
      {
        id: "faq-questions",
        label: "سوالات",
        href: "/faq/questions",
      },
    ],
  },
  // {
  //   id: "customer-club",
  //   label: "باشگاه مشتریان",
  //   href: "/customer-club",
  //   icon: <MultiUsersIcon />,
  //   children: [
  //     {
  //       id: "customer-club-actions",
  //       label: "عملیات ها",
  //       href: "/customer-club/actions",
  //     },
  //     {
  //       id: "customer-club-items",
  //       label: "آیتم ها",
  //       href: "/customer-club/items",
  //     },
  //   ],
  // },
  {
    id: "orders",
    label: "مدیریت سفارشات",
    href: "/orders",
    icon: <OrdersIcon />,
    children: [
      {
        id: "orders-carts",
        label: "سبدهای خرید",
        href: "/orders/carts",
        icon: <CartIcon />,
      },
    ],
  },
  {
    id: "payment-methods",
    label: "روش های پرداخت",
    href: "/payment-methods",
    icon: <PaymentIcon />,
    children: [],
  },
  {
    id: "discounts",
    label: "مدیریت تخفیف ها",
    href: "",
    icon: <PercentIcon />,
    children: [
      {
        id: "coupons",
        label: "کدهای تخفیف",
        href: "/coupons",
      },
      {
        id: "general-discounts",
        label: "تخفیفای عمومی",
        href: "/general-discounts",
      },
    ],
  },
  {
    id: "shipping",
    label: "مدیریت حمل و نقل",
    href: "/shipping",
    icon: <ShippingIcon />,
    children: [
      {
        id: "shipping-main",
        label: "حمل و نقل",
        href: "/shipping",
      },
      {
        id: "shipping-provinces",
        label: "مدیریت استان ها",
        href: "/shipping/provinces",
      },
      {
        id: "shipping-cities",
        label: "مدیریت شهرها",
        href: "/shipping/provinces/1/cities",
      },
    ],
  },
  // {
  //   id: "pages-content",
  //   label: "صفحات و محتوا",
  //   href: "/users",
  //   icon: <PagesIcon />,
  //   children: [],
  // },
  {
    id: "wallets",
    label: "مدیریت کیف پول",
    href: "/wallets",
    icon: <PaymentIcon />,
    children: [],
  },
  {
    id: "users",
    label: "مدیریت کاربران",
    href: "/users",
    icon: <UsersIcon />,
    children: [],
  },
  {
    id: "sales",
    label: "گزارشات",
    href: "/sales",
    icon: <ChartIcon />,
    // Sales children come from the same primary list the in-page
    // sub-navigation uses, so those surfaces cannot drift apart.
    children: SALES_NAV_ITEMS.map(({ id, label, href }) => ({
      id,
      label,
      href,
    })),
  },
  {
    id: "settings",
    label: "تنظیمات",
    href: "/settings",
    icon: <SettingsIcon />,
    children: [
      {
        id: "settings-general",
        label: "تنظیمات عمومی",
        href: "/settings/general",
      },
    ],
  },
  // {
  //   id: "notifications",
  //   label: "نوتیفیکیشن ها",
  //   href: "/notifications",
  //   icon: <BellIcon />,
  //   children: [],
  // },

  // {
  //   id: "cache",
  //   label: "حافظه پنهان",
  //   href: "/cache",
  //   icon: <CacheIcon />,
  //   children: [],
  // },
  // {
  //   id: "navbaredit",
  //   label: "مدیریت منوی ناوبری",
  //   href: "/navigation/edit",
  //   icon: <RarMenu />,
  //   children: [],
  // },
  // {
  //   id: "seo",
  //   label: "سئو",
  //   href: "/SEO",
  //   icon: <FiGlobe className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />,
  //   children: [],
  // },
];

const promoteChildren = (
  items: SidebarItem[],
  parentId: string,
): SidebarItem[] =>
  items.flatMap((item) =>
    item.id === parentId
      ? item.children.map((child) => ({
          id: child.id,
          label: child.label,
          href: child.href,
          icon: child.icon ?? item.icon,
          children: [],
        }))
      : [item],
  );

function balanceSidebarForRole(
  items: SidebarItem[],
  role: AdminRoleId,
): SidebarItem[] {
  if (role === "editor") {
    return promoteChildren(items, "blog");
  }

  if (
    ["seller1", "seller2", "store_manager", "store_manager_2"].includes(role)
  ) {
    return promoteChildren(items, "manage-products");
  }

  if (role !== "superadmin") return items;

  const storeOperations = new Set(["payment-methods", "discounts", "shipping"]);
  const customerOperations = new Set(["wallets", "users"]);
  const result: SidebarItem[] = [];

  for (const item of items) {
    if (storeOperations.has(item.id)) {
      if (result.some((candidate) => candidate.id === "store-operations"))
        continue;
      const grouped = items.filter((candidate) =>
        storeOperations.has(candidate.id),
      );
      result.push({
        id: "store-operations",
        label: "عملیات فروشگاه",
        icon: <ShippingIcon />,
        children: grouped.flatMap((candidate) =>
          candidate.children.length
            ? candidate.children
            : candidate.href
              ? [
                  {
                    id: candidate.id,
                    label: candidate.label,
                    href: candidate.href,
                  },
                ]
              : [],
        ),
      });
      continue;
    }

    if (customerOperations.has(item.id)) {
      if (result.some((candidate) => candidate.id === "customer-operations"))
        continue;
      const grouped = items.filter((candidate) =>
        customerOperations.has(candidate.id),
      );
      result.push({
        id: "customer-operations",
        label: "مشتریان و کیف پول",
        icon: <UsersIcon />,
        children: grouped.flatMap((candidate) =>
          candidate.href
            ? [
                {
                  id: candidate.id,
                  label: candidate.label,
                  href: candidate.href,
                },
              ]
            : candidate.children,
        ),
      });
      continue;
    }

    result.push(item);
  }

  return result;
}

export const getSidebarItemsForCapabilities = (
  capabilities: readonly AdminCapability[] | null | undefined,
  role?: AdminRoleId | string | null,
): SidebarItem[] => {
  const normalizedRole = normalizeAdminRole(role);
  if (!normalizedRole) return [];

  const filtered = superAdminSidebar.flatMap((item) => {
    const children = item.children
      .filter((child) =>
        canCapabilitiesAccessPath(capabilities, child.href, role),
      )
      .map((child) => ({ ...child }));
    const parentAllowed = item.href
      ? canCapabilitiesAccessPath(capabilities, item.href, role)
      : false;
    if (!parentAllowed && children.length === 0) return [];
    if (!parentAllowed && children.length === 1) {
      const child = children[0];
      return [
        {
          id: child.id,
          label: child.label,
          href: child.href,
          icon: child.icon ?? item.icon,
          children: [],
        },
      ];
    }
    return [
      {
        ...item,
        href: parentAllowed ? item.href : children[0]?.href,
        children,
      },
    ];
  });

  return balanceSidebarForRole(filtered, normalizedRole);
};

export const getSidebarItemsForRole = (
  roleName?: string | null,
): SidebarItem[] => {
  const role = normalizeAdminRole(roleName);
  return getSidebarItemsForCapabilities(capabilitiesForRole(role), role);
};

export default superAdminSidebar;
