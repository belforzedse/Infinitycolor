import type { Strapi } from "@strapi/strapi";
import { listEvidenceForAttempt } from "../../../payment-attempt-evidence/services/evidence";
import { findOrderPaymentAttempt } from "../../../payment-attempt/services/payment-attempt";
import {
  outcomeFromAttemptStatus,
  walletHoldStateFor,
} from "../../../payment-attempt/services/payment-attempt-outcome";

/**
 * Operator view of why an order's wallet credit is where it is.
 *
 * Everything an operator previously had to reconstruct by hand: the hold's
 * lifecycle and the reason it was released, the last thing the provider
 * actually said, and the append-only recovery evidence. The evidence rows are
 * the point — they are the only durable record of an automatic decision, since
 * `provider_response` is overwritten by every later observation.
 *
 * Strictly read-only, and guarded by `order.financial.read` at the route.
 */
export async function adminWalletRecoveryHandler(strapi: Strapi, ctx: any) {
  const orderId = Number(ctx.params?.id);
  if (!Number.isFinite(orderId)) {
    return ctx.badRequest("A numeric order id is required");
  }

  const attempt: any = await findOrderPaymentAttempt(strapi as any, orderId);
  if (!attempt) {
    return ctx.send({ success: true, data: { attempt: null, evidence: [] } });
  }

  const evidence = await listEvidenceForAttempt(strapi, Number(attempt.id)).catch(() => []);
  const providerResponse =
    attempt.providerResponse && typeof attempt.providerResponse === "object"
      ? (attempt.providerResponse as Record<string, unknown>)
      : {};

  return ctx.send({
    success: true,
    data: {
      attempt: {
        id: Number(attempt.id),
        attemptId: String(attempt.attemptId || ""),
        gateway: String(attempt.Gateway || ""),
        status: String(attempt.Status || ""),
        providerStatus: attempt.providerStatus || null,
        nextAction: attempt.nextAction || null,
        failureCode: attempt.failureCode || null,
        failureMessage: attempt.failureMessage || null,
        lastReconciledAt: attempt.lastReconciledAt || null,
        outcome: outcomeFromAttemptStatus(attempt),
        wallet: {
          holdStatus: attempt.WalletHoldStatus || null,
          amountIrr: Number(attempt.WalletAmount || 0),
          heldAt: attempt.WalletHeldAt || null,
          capturedAt: attempt.WalletCapturedAt || null,
          releasedAt: attempt.WalletReleasedAt || null,
          releaseReason: attempt.WalletReleaseReason || null,
          state:
            attempt.WalletHoldStatus === "Active" ? walletHoldStateFor(attempt) : null,
        },
        // The last provider call this attempt recorded. A cache, not evidence:
        // the merge writer overwrites it and a generation rotation replaces it
        // wholesale, which is exactly why the rows below exist.
        lastProviderRead: {
          endpoint: providerResponse.endpoint ?? null,
          httpStatus: providerResponse.httpStatus ?? null,
          providerCode: providerResponse.providerCode ?? null,
          successful: providerResponse.successful ?? null,
        },
      },
      evidence,
    },
  });
}
