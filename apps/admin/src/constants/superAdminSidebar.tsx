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
} from "react-icons/fi";

// Create a styled layout/menu icons (unused definitions removed)
const RarMenu = () => <FiMenu className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />;
//Create a styled club icon
const _MultiUsersIcon = () => (
  <FiUsers className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />
);

//Create a styled Pages icon
const _PagesIcon = () => <FiLayers className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />;

const BellIcon = () => <FiBell className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />;
const ChartIcon = () => <FiBarChart className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />;

const _CacheIcon = () => <FiDatabase className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />;

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
    icon: <FiSliders className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />,
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
        id: "productس",
        label: " محصولات",
        href: "/products",
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
      },
      {
        id: "product-tags",
        label: "برچسب ها",
        href: "/products/tags",
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
      },
      {
        id: "product-attributes",
        label: "ویژگی ها",
        href: "/products/attributes",
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
      },
      {
        id: "blog-posts",
        label: "مدیریت پست‌ها",
        href: "/blog/posts",
      },
      {
        id: "blog-categories",
        label: "دسته‌بندی‌ها",
        href: "/blog/categories",
      },
      {
        id: "blog-category-banners",
        label: "بنر دسته‌بندی‌ها",
        href: "/blog/categories/banners",
      },
      {
        id: "blog-tags",
        label: "برچسب‌ها",
        href: "/blog/tags",
      },
      {
        id: "blog-authors",
        label: "نویسندگان",
        href: "/blog/authors",
      },
      {
        id: "blog-comments",
        label: "مدیریت نظرات",
        href: "/blog/comments",
      },
    ],
  },
  {
    id: "stories",
    label: "استوری‌ها",
    href: "/stories",
    icon: <FiPlayCircle className="h-5 w-5 text-infinity-primary" stroke="#3d4c6e" />,
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
    children: [],
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
    // Children come from the same list the in-page sub-navigation uses, so the
    // two cannot drift apart. Includes the admin activity report
    // (`sales-activity`, pointing at /settings/activity) alongside the sales
    // reports proper — this is the one place both live.
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

export const getSidebarItemsForCapabilities = (
  capabilities: readonly AdminCapability[] | null | undefined,
  role?: AdminRoleId | string | null,
): SidebarItem[] =>
  superAdminSidebar.flatMap((item) => {
    const children = item.children
      .filter((child) => canCapabilitiesAccessPath(capabilities, child.href, role))
      .map((child) => ({ ...child }));
    const parentAllowed = item.href
      ? canCapabilitiesAccessPath(capabilities, item.href, role)
      : false;
    if (!parentAllowed && children.length === 0) return [];
    return [
      {
        ...item,
        href: parentAllowed ? item.href : children[0]?.href,
        children,
      },
    ];
  });

export const getSidebarItemsForRole = (roleName?: string | null): SidebarItem[] => {
  const role = normalizeAdminRole(roleName);
  return getSidebarItemsForCapabilities(capabilitiesForRole(role), role);
};

export default superAdminSidebar;
