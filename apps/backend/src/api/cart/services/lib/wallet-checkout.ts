import type { Strapi } from "@strapi/strapi";
import {
  isWalletSnappaySplitEnabled,
  isWalletSplitEnabled,
} from "../../../local-user-wallet/services/wallet-readiness";
import {
  listActiveHoldsForUser,
  readWalletAvailability,
} from "../../../local-user-wallet/services/wallet-holds";
import { isSnappayGatewayValue } from "../../../payment-gateway/services/checkout-gateway-availability";
import { isCheckoutGatewayEnabled } from "../../../payment-gateway/services/checkout-gateway-availability";
import {
  buildPaymentCapabilities,
  resolvePaymentAllocation,
  type PaymentAllocation,
  type PaymentCapabilities,
} from "./payment-allocation";

export type WalletCheckoutContext = {
  capabilities: PaymentCapabilities;
  availability: Awaited<ReturnType<typeof readWalletAvailability>>;
  /** Resolves the split for a total. Throws `PaymentAllocationError` on refusal. */
  resolve: (totalToman: number) => PaymentAllocation;
};

/**
 * Everything the quote and finalize paths need to agree on a wallet split.
 *
 * Both call this so that what a quote advertised and what finalize enforces are
 * produced by the same code with the same inputs. The availability read is
 * lock-free — quoting must never write, and must never take the wallet lock.
 *
 * `supersedeAttemptId` is the one predecessor attempt whose hold this checkout
 * may reuse. It is reported as `walletReusableToman`, separate from what is
 * actually spendable, and it is only honoured for an attempt the caller owns.
 */
export async function buildWalletCheckoutContext(
  strapi: Strapi,
  userId: number,
  input: {
    selectedGateway: string;
    requestedWalletAmount: unknown;
    supersedeAttemptId?: string | null;
  },
): Promise<WalletCheckoutContext> {
  const walletGatewayAvailable = await isCheckoutGatewayEnabled(strapi, "wallet");
  const capabilities = buildPaymentCapabilities({
    walletGatewayAvailable,
    splitEnabled: isWalletSplitEnabled(),
    snappaySplitEnabled: isWalletSnappaySplitEnabled(),
  });
  const availability = await readWalletAvailability(strapi, userId, {
    reusableAttemptId: input.supersedeAttemptId,
  });

  // Opening the checkout with credit tied up in an earlier attempt nudges that
  // attempt's reconciliation forward. This is the same self-heal the wallet
  // page performs: the shopper who most wants their money back is the one
  // looking at the page, and a page view is a free opportunity to move the
  // recovery along. Fire-and-forget — the quote never waits on it.
  if (availability.heldIrr > 0) {
    void nudgeHeldAttempts(strapi, userId);
  }

  return {
    capabilities,
    availability,
    resolve: (totalToman: number) =>
      resolvePaymentAllocation({
        totalToman,
        requestedWalletAmount: input.requestedWalletAmount,
        selectedGateway: input.selectedGateway,
        balanceIrr: availability.balanceIrr,
        heldIrr: availability.heldIrr,
        availableIrr: availability.availableIrr,
        reusableIrr: availability.reusableIrr,
        balanceUnavailable: availability.degraded === true,
        capabilities,
      }),
  };
}


/**
 * Throttled, fire-and-forget reconcile nudge for the caller's live SnappPay
 * holds. Never throws and never delays the quote.
 */
async function nudgeHeldAttempts(strapi: Strapi, userId: number): Promise<void> {
  try {
    const orchestrator = strapi.service("api::payment-gateway.snappay-orchestrator") as any;
    if (typeof orchestrator?.pullForHold !== "function") return;
    const holds = await listActiveHoldsForUser(strapi, userId);
    for (const hold of holds.slice(0, 3)) {
      if (!isSnappayGatewayValue(hold.gateway)) continue;
      if (hold.state !== "reconciling" && hold.state !== "reclaimable") continue;
      await Promise.resolve(orchestrator.pullForHold(hold.paymentAttemptId)).catch(
        () => undefined,
      );
    }
  } catch {
    // A checkout quote must never fail because a background nudge did.
  }
}
