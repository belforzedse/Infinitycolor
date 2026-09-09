import AccountIcon from "@/components/User/Icons/AccountIcon";
import UserOrdersIcon from "@/components/User/Icons/UserOrdersIcon";
import UserFavoritesIcon from "@/components/User/Icons/UserFavoritesIcon";
// removed unused import: UserScoresIcon from "@/components/User/Icons/UserScoresIcon"
import UserWalletIcon from "@/components/User/Icons/UserWalletIcon";
import UserAddressesIcon from "@/components/User/Icons/UserAddressesIcon";
import UserPasswordIcon from "@/components/User/Icons/UserPasswordIcon";
import LogoutIcon from "@/components/Icons/LogoutIcon";
import { OrderStatus, PersianOrderStatus } from "@/constants/enums";

export const USER_SIDEBAR_ITEMS = [
  {
    href: "/account",
    icon: <AccountIcon />,
    text: "اطلاعات کاربری",
  },
  {
    href: "/orders",
    icon: <UserOrdersIcon />,
    text: "سفارش ها",
  },
  {
    href: "/favorites",
    icon: <UserFavoritesIcon />,
    text: "علاقه مندی ها",
  },
  {
    href: "/wallet",
    icon: <UserWalletIcon />,
    text: "کیف پول",
  },
  {
    href: "/addresses",
    icon: <UserAddressesIcon />,
    text: "آدرس ها",
  },
  {
    href: "/password",
    icon: <UserPasswordIcon />,
    text: "رمز عبور",
  },
];

export const LOGOUT_ITEM = {
  icon: <LogoutIcon />,
  text: "خروج",
};

export const PREDEFINED_INCREASE_BALANCE_AMOUNTS = [50000, 100000, 150000, 200000, 500000, 1000000];

/**
 * The reserve tab is keyed separately from `PersianOrderStatus`: a reserve group
 * is not an order status, it is a shipment that spans several orders, each of
 * which keeps its own status.
 */
export const RESERVE_ORDERS_TAB_KEY = "RESERVE";
export const RESERVE_ORDERS_TAB_LABEL = "سفارش‌های رزروی";

export const ORDER_STATUS = [
  { key: "ALL", value: "همه سفارش‌ها" },
  { key: OrderStatus.Processing, value: PersianOrderStatus.INPROGRESS },
  { key: OrderStatus.Delivered, value: PersianOrderStatus.DELIVERED },
  { key: OrderStatus.Cancelled, value: PersianOrderStatus.CANCELLED },
  { key: "MANUAL", value: PersianOrderStatus.MANUAL },
  { key: RESERVE_ORDERS_TAB_KEY, value: RESERVE_ORDERS_TAB_LABEL },
];
