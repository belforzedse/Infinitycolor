/**
 * Splits an order's funding into the methods that actually paid for it.
 *
 * An order can be settled from more than one source — most often part from the
 * customer's wallet balance and the rest from a gateway. `orders.PaymentGateway`
 * is a single scalar and cannot express that, so the legs have to be read from
 * the contract transactions, which carry one row per funding source with its
 * own amount.
 *
 * Display-only. Nothing here decides money; it reads what settlement already wrote.
 */
import { getPaymentGatewayLabel, resolvePaymentGateway } from "./paymentGateways";

export interface OrderPaymentLeg {
  /** Canonical gateway key when recognised, else the raw channel value. */
  method: string;
  /** Persian label, ready to render. */
  label: string;
  /** Funding carried by this method, in IRR. */
  amountIrr: number;
  isWallet: boolean;
}

/** The shape the order detail page already unwraps out of `contract.contract_transactions`. */
export interface PaymentLegTransaction {
  Type?: string | null;
  Status?: string | null;
  Amount?: number | string | null;
  SettlementGateway?: string | null;
  external_source?: string | null;
}

const toIrr = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
};

/**
 * `woocommerce` is the importer's provenance marker, not a payment channel. It
 * only ever appears as `external_source`, and on migrated rows the real channel
 * is in `SettlementGateway`, so it is never the answer.
 */
const isProvenanceMarker = (value: string): boolean =>
  value.trim().toLowerCase() === "woocommerce";

/**
 * The channel that funded a leg.
 *
 * Both columns must be consulted, because different writers populate different
 * ones: the WooCommerce importer sets `SettlementGateway`, the live SnappPay and
 * wallet legs set it too, but the Mellat / SamanKish / ZarinPal gateway legs set
 * only `external_source`. Reading either column alone silently loses a whole
 * class of orders.
 */
const legMethod = (tx: PaymentLegTransaction): string => {
  const settlement = String(tx.SettlementGateway || "").trim();
  if (settlement && !isProvenanceMarker(settlement)) return settlement;
  const source = String(tx.external_source || "").trim();
  if (source && !isProvenanceMarker(source)) return source;
  return "";
};

/**
 * Funding legs for an order, largest first.
 *
 * Only `Gateway` rows count: `Return` rows are refunds moving money back out, and
 * including them would misreport what the customer paid. Rows that carry no
 * amount or no identifiable channel are dropped rather than rendered as blanks.
 */
export function readOrderPaymentLegs(
  transactions: PaymentLegTransaction[] | null | undefined,
): OrderPaymentLeg[] {
  const byMethod = new Map<string, OrderPaymentLeg>();

  for (const tx of transactions || []) {
    if (String(tx?.Type || "") !== "Gateway") continue;
    const amountIrr = toIrr(tx?.Amount);
    if (!amountIrr) continue;
    const method = legMethod(tx);
    if (!method) continue;

    const meta = resolvePaymentGateway(method);
    const key = meta?.key || method.toLowerCase();
    const existing = byMethod.get(key);
    if (existing) {
      existing.amountIrr += amountIrr;
      continue;
    }
    byMethod.set(key, {
      method: key,
      label: getPaymentGatewayLabel(method),
      amountIrr,
      isWallet: meta?.key === "wallet",
    });
  }

  return [...byMethod.values()].sort((a, b) => b.amountIrr - a.amountIrr);
}

/**
 * The gateway to treat as "the" gateway for operator actions that only make
 * sense for one provider, such as the SnappPay cancel and adjust panels.
 *
 * Deliberately the largest non-wallet leg. Picking the last transaction instead
 * is wrong on a split order: the wallet leg is written later, at capture, so the
 * last row is usually the wallet one — which made a wallet+SnappPay order look
 * like a wallet order and hid the SnappPay panels on exactly those orders.
 */
export function primaryGatewayMethod(legs: OrderPaymentLeg[]): string | undefined {
  return legs.find((leg) => !leg.isWallet)?.method || legs[0]?.method;
}
