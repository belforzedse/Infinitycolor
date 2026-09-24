"use client";

import { useMemo } from "react";
import { faNum } from "@/utils/faNum";
import { priceFormatter } from "@/utils/price";
import PaymentGatewayBadge from "@/components/PaymentGateway/PaymentGatewayBadge";
import { resolvePaymentGateway } from "@/utils/paymentGateways";
import type { GatewayBreakdownRow } from "@/services/super-admin/reports/products";
import { ShareCell } from "./AnalyticsTable";
import { ShareSummary, ShareTip } from "./ShareBar";
import { buildShares } from "./shares";
import { numberText, ratioText, tomanText } from "./format";

/**
 * A gateway keeps its colour on every page and in every range: Saman is
 * always the first hue, SnappPay the second, and so on. Channels without a
 * slot borrow a free one; an unattributed channel is «نامشخص» grey.
 */
const GATEWAY_SLOTS: Record<string, number> = {
  samankish: 0,
  snappay: 1,
  mellat: 2,
  wallet: 3,
  zarinpal: 4,
};

function gatewayKey(gateway: string) {
  return resolvePaymentGateway(gateway)?.key ?? gateway.toLowerCase();
}

/**
 * Cash collected per gateway. One table for every page that shows it — the
 * products «پرداخت و ارسال» tab and the «نقدینگی» page — fed by the same
 * backend query, so the two can never disagree. A slim share bar above it
 * shows how the cash splits; each row repeats its share beside the number.
 *
 * A split payment (wallet + gateway) sits under both channels, so the
 * per-row order counts can add up to more than `ordersCount`, which is the
 * distinct number of paid orders. The amounts are per leg and do partition
 * the total, which is why the share bar is drawn over amounts.
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
  const byKey = useMemo(() => new Map(rows.map((row) => [gatewayKey(row.gateway), row])), [rows]);
  const shares = useMemo(
    () =>
      buildShares(
        rows.map((row) => ({
          key: gatewayKey(row.gateway),
          label: row.label,
          value: Number(row.total),
          unknown: gatewayKey(row.gateway) === "unknown",
        })),
        { fixedSlots: GATEWAY_SLOTS },
      ),
    [rows],
  );
  return (
    <div className="space-y-4">
      {shares ? (
        <ShareSummary
          segments={shares.segments}
          label="سهم درگاه‌ها از مبلغ دریافتی"
          describe={(segment) => `${segment.label}: ${ratioText(segment.share)}، ${tomanText(segment.value)}`}
          tipContent={(segment) => {
            const row = byKey.get(segment.key);
            return (
              <ShareTip
                segment={segment}
                valueText={tomanText(segment.value)}
                extra={row ? <p className="text-slate-600">{numberText(row.ordersCount)} سفارش</p> : null}
              />
            );
          }}
          note={
            shares.excluded
              ? `${numberText(shares.excluded)} درگاه بدون مبلغ دریافتی در سهم‌ها نیامده است.`
              : null
          }
        />
      ) : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-100 text-right text-xs text-neutral-500">
            <th scope="col" className="py-2 font-medium">درگاه</th>
            <th scope="col" className="py-2 text-left font-medium">تعداد سفارش</th>
            <th scope="col" className="py-2 text-left font-medium">مبلغ</th>
            <th scope="col" className="py-2 text-left font-medium">سهم</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.gateway} className="border-b border-neutral-50 last:border-0">
              <td className="py-2.5 font-medium text-neutral-800">
                {resolvePaymentGateway(g.gateway) ? <PaymentGatewayBadge gateway={g.gateway} /> : g.label}
              </td>
              <td className="py-2.5 text-left tabular-nums text-neutral-600">{faNum(g.ordersCount)}</td>
              <td className="py-2.5 text-left tabular-nums text-neutral-800">{priceFormatter(g.total, " تومان")}</td>
              <td className="py-2.5 text-left tabular-nums text-neutral-600">
                {g.sharePct === null ? (
                  "—"
                ) : (
                  <ShareCell share={g.sharePct / 100}>{`${faNum(g.sharePct)}٪`}</ShareCell>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t border-neutral-200 text-xs font-semibold text-neutral-700">
              <td className="py-2.5">مجموع</td>
              <td className="py-2.5 text-left tabular-nums">{faNum(ordersCount)}</td>
              <td className="py-2.5 text-left tabular-nums">{priceFormatter(totalSales, " تومان")}</td>
              <td className="py-2.5" />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
