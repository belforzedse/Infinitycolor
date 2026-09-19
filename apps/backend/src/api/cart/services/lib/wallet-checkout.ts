import type { Strapi } from "@strapi/strapi";
import {
  isWalletSnappaySplitEnabled,
  isWalletSplitEnabled,
} from "../../../local-user-wallet/services/wallet-readiness";
import { readWalletAvailability } from "../../../local-user-wallet/services/wallet-holds";
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
