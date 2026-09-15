"use client";

import { faNum } from "@/utils/faNum";
import { priceFormatter } from "@/utils/price";
import PaymentGatewayBadge from "@/components/PaymentGateway/PaymentGatewayBadge";
import { resolvePaymentGateway } from "@/utils/paymentGateways";
import type { GatewayBreakdownRow } from "@/services/super-admin/reports/products";

/**
 * Cash collected per gateway. One table for every page that shows it — the
 * products «پرداخت و ارسال» tab and the «نقدینگی» page — fed by the same
 * backend query, so the two can never disagree.
 *
 * A split payment (wallet + gateway) sits under both channels, so the
 * per-row order counts can add up to more than `ordersCount`, which is the
 * distinct number of paid orders.
 */
export default function GatewayBreakdownTable({
  rows,
  totalSales,
  ordersCount,
}: {
  rows: GatewayBreakdownRow[];
  totalSales: number;
  ordersCount: number;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-neutral-100 text-right text-xs text-neutral-500">
          <th className="py-2 font-medium">درگاه</th>
          <th className="py-2 text-left font-medium">تعداد سفارش</th>
          <th className="py-2 text-left font-medium">مبلغ</th>
          <th className="py-2 text-left font-medium">سهم</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((g) => (
          <tr key={g.gateway} className="border-b border-neutral-50 last:border-0">
            <td className="py-2.5 font-medium text-neutral-800">
              {resolvePaymentGateway(g.gateway) ? (
                <PaymentGatewayBadge gateway={g.gateway} />
              ) : (
                g.label
              )}
            </td>
            <td className="py-2.5 text-left text-neutral-600">{faNum(g.ordersCount)}</td>
            <td className="py-2.5 text-left text-neutral-800">
              {priceFormatter(g.total, " تومان")}
            </td>
            <td className="py-2.5 text-left text-neutral-600">
              {g.sharePct === null ? "—" : `${faNum(g.sharePct)}٪`}
            </td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && (
        <tfoot>
          <tr className="border-t border-neutral-200 text-xs font-semibold text-neutral-700">
            <td className="py-2.5">مجموع</td>
            <td className="py-2.5 text-left">{faNum(ordersCount)}</td>
            <td className="py-2.5 text-left">{priceFormatter(totalSales, " تومان")}</td>
            <td className="py-2.5" />
          </tr>
        </tfoot>
      )}
    </table>
  );
}
