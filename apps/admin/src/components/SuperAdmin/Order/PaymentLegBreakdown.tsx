import type { OrderPaymentLeg } from "@/utils/paymentLegs";
import { priceFormatter, rialToToman } from "@/utils/price";

/**
 * The methods that funded one order, with what each covered.
 *
 * Shown when an order was paid from more than one source — typically part from
 * the customer's wallet balance and the rest from a gateway. The single
 * `orders.PaymentGateway` value cannot express that, so support could not see
 * the wallet portion at all.
 *
 * Leg amounts are IRR (`contract_transactions.Amount`); the rest of this screen
 * is in toman, so they are converted for display.
 */
export default function PaymentLegBreakdown({ legs }: { legs: OrderPaymentLeg[] }) {
  if (!legs.length) return <>—</>;

  const totalIrr = legs.reduce((sum, leg) => sum + leg.amountIrr, 0);

  return (
    <div className="flex flex-col gap-1">
      {legs.map((leg) => (
        <div key={leg.method} className="flex items-center justify-between gap-3">
          <span>{leg.label}</span>
          <span className="tabular-nums">
            {priceFormatter(rialToToman(leg.amountIrr), " تومان")}
          </span>
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between gap-3 border-t pt-1 font-medium">
        <span>جمع</span>
        <span className="tabular-nums">
          {priceFormatter(rialToToman(totalIrr), " تومان")}
        </span>
      </div>
    </div>
  );
}
