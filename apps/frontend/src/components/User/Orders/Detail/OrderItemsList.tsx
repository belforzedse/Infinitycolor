import Image from "next/image";
import type { Order, OrderItem } from "@/services/order";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { faNum } from "@/utils/faNum";
import { formatOrderItemAttributes } from "@/utils/orderDisplayHelpers";

const getItemImage = (item: OrderItem) => {
  const product = item.product_variation?.product as any;
  const directUrl = product?.cover_image?.url || product?.CoverImage?.url;
  if (!directUrl) return "";
  return resolveAssetUrl(directUrl);
};

interface OrderItemsListProps {
  order: Order;
}

export default function OrderItemsList({ order }: OrderItemsListProps) {
  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
      <h2 className="mb-4 text-base font-semibold text-foreground-primary">اقلام سفارش</h2>
      <div className="flex flex-col divide-y divide-slate-100">
        {order.order_items.map((item) => {
          const image = getItemImage(item);
          const variations = formatOrderItemAttributes(item);
          const total = Number(item.Count || 0) * Number(item.PerAmount || 0);

          return (
            <div key={item.id} className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between">
              <div className="flex flex-1 items-center gap-3">
                <div className="relative h-16 w-16 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  {image ? (
                    <Image src={image} alt={item.ProductTitle} fill className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">تصویر</div>
                  )}
                </div>
                <div className="flex flex-col gap-1 text-right">
                  <span className="text-sm font-medium text-foreground-primary">
                    {item.ProductTitle || item.product_variation?.product?.Title || "بدون نام"}
                  </span>
                  {variations ? <span className="text-xs text-slate-500">{variations}</span> : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
                <span>تعداد: {faNum(item.Count)}</span>
                <span>قیمت واحد: {faNum(item.PerAmount)} تومان</span>
                <span className="font-semibold text-foreground-primary">جمع: {faNum(total)} تومان</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

