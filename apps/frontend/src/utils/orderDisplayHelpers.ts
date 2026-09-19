/**
 * Shared helpers for mapping Order to display props (OrderCard/OrderRow).
 * Used by reserve group page and orders Tabs.
 */

import type { PersianOrderStatus } from "@/constants/enums";
import type { Order, OrderItem } from "@/services/order";
import { getOrderStatusCategory, translateOrderStatus } from "@/utils/statusTranslations";
import {
  customVariantAttributes,
  findAttributeTerm,
  formatVariantAttribute,
  isColorAttribute,
  isModelAttribute,
  isSizeAttribute,
  variationAttributeTerms,
  type VariantAttribute,
} from "@/utils/orderAttributes";

/**
 * Every attribute of a purchased line, for display.
 *
 * Reads the order-item snapshot first and only then falls back to the live
 * variation. Two spellings are in play and mixing them up renders nothing:
 * the snapshot columns on `order_items` are `product_color`/`product_size`,
 * while the same relations on `product-variation` are `product_variation_color`
 * /`product_variation_size`. Every storefront order view used to read
 * `item.product_variation.product_size`, a path that exists on neither entity,
 * so sizes were silently absent from order history.
 *
 * Colour, size and model are simply the three attributes with a relation column
 * of their own, and even they can live purely as a catalog term. `custom` holds
 * the rest — a «کد» design code, a pattern — each with its own attribute name;
 * they are shown alongside the other three, not in place of them.
 */
export function getOrderItemAttributes(item: OrderItem): {
  color?: string;
  size?: string;
  model?: string;
  custom: VariantAttribute[];
} {
  const variation = item.product_variation;
  const pick = (value?: string | null) => {
    const text = String(value ?? "").trim();
    return text.length > 0 ? text : undefined;
  };

  const terms = variationAttributeTerms(variation);
  const color =
    pick(item.product_color?.Title) ??
    pick(variation?.product_variation_color?.Title) ??
    pick(findAttributeTerm(terms, isColorAttribute)?.Title);
  const size =
    pick(item.product_size?.Title) ??
    pick(variation?.product_variation_size?.Title) ??
    pick(findAttributeTerm(terms, isSizeAttribute)?.Title);
  const model =
    pick(item.product_variation_model?.Title) ??
    pick(variation?.product_variation_model?.Title) ??
    pick(findAttributeTerm(terms, isModelAttribute)?.Title);

  return { color, size, model, custom: customVariantAttributes(terms, [color, size, model]) };
}

/**
 * Renders the attributes as the `رنگ: … | سایز: …` line used across order views.
 * Returns "" when the line has no attributes worth showing.
 */
export function formatOrderItemAttributes(item: OrderItem, separator = " | "): string {
  const { color, size, model, custom } = getOrderItemAttributes(item);
  const parts: string[] = [];
  if (color) parts.push(`رنگ: ${color}`);
  if (size) parts.push(`سایز: ${size}`);
  if (model) parts.push(`مدل: ${model}`);
  // Named the same way as the three above — «کد: ۱» — except when the term
  // already spells the attribute out, which imported terms usually do.
  for (const attribute of custom) parts.push(formatVariantAttribute(attribute, ": "));
  return parts.join(separator);
}

export function formatOrderDate(dateString: string): string {
  return new Intl.DateTimeFormat("fa-IR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(dateString));
}

export function formatOrderTime(dateString: string): string {
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(dateString));
}

export function persistOrderSnapshot(order: Order): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(`infinity:order-detail:${order.id}`, JSON.stringify(order));
  } catch {
    // ignore
  }
}

export const isAwaitingPayment = (status?: string | null): boolean =>
  String(status ?? "").trim().toLowerCase() === "paying";

export interface OrderDisplayRowProps {
  id: string;
  title: string;
  date: string;
  time: string;
  price: string;
  status: PersianOrderStatus;
  /** Granular lifecycle label; `status` is only the tab bucket. */
  statusLabel?: string;
  awaitingPayment?: boolean;
  image: string;
  category: string;
  orderId?: number;
  shippingBarcode?: string;
  detailHref: string;
  onViewDetails: () => void;
  onOpenFullDetails?: () => void;
  isReserveOrder?: boolean;
  reserveExpiresAt?: string | null;
  reserveState?: string | null;
  reserveClosureReason?: string | null;
  reserveIsActive?: boolean;
  reserveGroupOrderCount?: number;
  onReleaseReserve?: (orderId: number) => void;
  isReleasingReserve?: boolean;
  rawOrder?: Order | null;
  isGroupRow?: boolean;
  sortDate?: string;
}

export interface MapOrderToDisplayPropsContext {
  imageBaseUrl: string;
  placeholderImage: string;
  formatDate: (dateString: string) => string;
  formatTime: (dateString: string) => string;
  faNum: (n: number) => string;
  /** Used when all listed orders are in one group (e.g. reserve page). Otherwise use getReserveGroupCount. */
  ordersLength: number;
  /** When provided (e.g. Tabs), used to compute reserveGroupOrderCount per order. */
  getReserveGroupCount?: (order: Order) => number | undefined;
  handleReleaseReserve: (orderId: number) => void;
  persistOrderSnapshot: (order: Order) => void;
  releasingOrderId: number | null;
  setSelectedOrder: (order: Order | null) => void;
}

/**
 * Maps a single API Order to the props shape expected by OrderCard/OrderRow.
 */
export function mapOrderToDisplayProps(
  order: Order,
  context: MapOrderToDisplayPropsContext,
): OrderDisplayRowProps {
  const firstItem = order.order_items?.[0];
  const product = firstItem?.product_variation?.product as
    | { cover_image?: { url?: string }; CoverImage?: { url?: string }; Title?: string }
    | null
    | undefined;
  const coverImage = product?.cover_image ?? product?.CoverImage;
  // Pass the relative cover url through; imageLoader/resolveSafeImageSrc resolves it
  // against the trusted origin (avoids double-slash / wrong-host from naive concatenation).
  const image = coverImage?.url ?? context.placeholderImage;
  const category =
    firstItem?.product_variation?.product?.Title ??
    firstItem?.ProductTitle ??
    "محصول";
  const totalPrice =
    (order.order_items?.reduce((sum, item) => sum + item.Count * item.PerAmount, 0) ?? 0) +
    (order.ShippingCost ?? 0);
  // The bucket drives tabs and icon tone only. Printing it as the status text
  // called an unpaid (Paying) order «در حال انجام», because Paying has no bucket
  // of its own and falls into in-progress.
  const status = getOrderStatusCategory(order.Status);
  const statusLabel = translateOrderStatus(order.Status);
  const awaitingPayment = isAwaitingPayment(order.Status);

  const reserveGroupOrderCount = context.getReserveGroupCount
    ? context.getReserveGroupCount(order)
    : order.reserveGroupId && order.isReserveOrder && context.ordersLength > 0
      ? context.ordersLength
      : undefined;

  return {
    id: order.id.toString(),
    title: `سفارش شماره #${order.id}`,
    date: context.formatDate(order.createdAt),
    time: context.formatTime(order.createdAt),
    price: context.faNum(totalPrice),
    status,
    statusLabel,
    awaitingPayment,
    image,
    category,
    orderId: order.id,
    shippingBarcode: order.ShippingBarcode,
    detailHref: `/orders/${order.id}`,
    isReserveOrder: order.isReserveOrder,
    reserveExpiresAt: order.reserveExpiresAt,
    reserveState: order.reserveState,
    reserveClosureReason: order.reserveClosureReason,
    reserveIsActive: order.reserveIsActive,
    reserveGroupOrderCount,
    onReleaseReserve: context.handleReleaseReserve,
    isReleasingReserve: context.releasingOrderId === order.id,
    onViewDetails: () => context.setSelectedOrder(order),
    onOpenFullDetails: () => context.persistOrderSnapshot(order),
    rawOrder: order,
    isGroupRow: false,
    sortDate: order.createdAt,
  };
}
