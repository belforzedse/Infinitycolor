"use client";

import { useMemo } from "react";
import { faNum } from "@/utils/faNum";
import { priceFormatter } from "@/utils/price";
import { cn } from "@/utils/tailwind";
import PaymentGatewayBadge from "@/components/PaymentGateway/PaymentGatewayBadge";
import { resolvePaymentGateway } from "@/utils/paymentGateways";
import type { GatewayBreakdownRow, PaymentMix } from "@/services/super-admin/reports/products";
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
 *
 * The footer spells that out with `paymentMix`: orders paid one way, orders
 * split across channels, and all paid orders — the first two add up to the
 * third in both columns. Without it (an API older than the field) the footer
 * falls back to the single total row.
 */
export default function GatewayBreakdownTable({
  rows,
  totalSales,
  ordersCount,
  paymentMix,
}: {
  rows: GatewayBreakdownRow[];
  totalSales: number;
  ordersCount: number;
  paymentMix?: PaymentMix;
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
            {paymentMix ? (
              <PaymentMixRows
                mix={paymentMix}
                rowCountSum={rows.reduce((sum, row) => sum + Number(row.ordersCount || 0), 0)}
                totalSales={totalSales}
                ordersCount={ordersCount}
              />
            ) : (
              <FooterRow label="مجموع" count={ordersCount} amount={totalSales} divider strong />
            )}
          </tfoot>
        )}
      </table>
    </div>
  );
}

function PaymentMixRows({
  mix,
  rowCountSum,
  totalSales,
  ordersCount,
}: {
  mix: PaymentMix;
  rowCountSum: number;
  totalSales: number;
  ordersCount: number;
}) {
  // Every row appearance beyond one per order belongs to a mixed order.
  const mixedAppearances = rowCountSum - mix.singleOrdersCount;
  // Only the «completed» fallback can count a paid order with no settled leg.
  const unsettled = ordersCount - mix.singleOrdersCount - mix.mixedOrdersCount;
  return (
    <>
      <FooterRow
        label="پرداخت با یک روش"
        hint="هر سفارش فقط در یک ردیف بالا آمده است"
        count={mix.singleOrdersCount}
        amount={mix.singleTotal}
        divider
      />
      <FooterRow
        label="پرداخت ترکیبی"
        hint={
          mix.mixedOrdersCount > 0
            ? `مثل کیف پول + درگاه؛ هر سفارش در ردیف همه روش‌هایش آمده و در ستون «تعداد سفارش» جمعاً ${faNum(mixedAppearances)} بار شمرده شده است`
            : "مثل کیف پول + درگاه؛ هر سفارش در ردیف همه روش‌هایش آمده است"
        }
        count={mix.mixedOrdersCount}
        amount={mix.mixedTotal}
      />
      {unsettled > 0 && (
        <FooterRow
          label="بدون تراکنش موفق"
          hint="در هیچ ردیفی نیامده است"
          count={unsettled}
          amount={0}
        />
      )}
      <FooterRow
        label="مجموع سفارش‌های پرداخت‌شده"
        hint="هر سفارش یک بار شمرده شده است"
        count={ordersCount}
        amount={totalSales}
        divider
        strong
      />
    </>
  );
}

function FooterRow({
  label,
  hint,
  count,
  amount,
  divider = false,
  strong = false,
}: {
  label: string;
  hint?: string;
  count: number;
  amount: number;
  divider?: boolean;
  strong?: boolean;
}) {
  return (
    <tr
      className={cn(
        "text-xs",
        divider && "border-t border-neutral-200",
        strong ? "font-semibold text-neutral-700" : "text-neutral-600",
      )}
    >
      <td className="py-2.5">
        <div className={strong ? undefined : "font-medium text-neutral-700"}>{label}</div>
        {hint ? <div className="mt-0.5 text-[11px] font-normal text-neutral-500">{hint}</div> : null}
      </td>
      <td className="py-2.5 text-left align-top tabular-nums">{faNum(count)}</td>
      <td className="py-2.5 text-left align-top tabular-nums">{priceFormatter(amount, " تومان")}</td>
      <td className="py-2.5" />
    </tr>
  );
}
