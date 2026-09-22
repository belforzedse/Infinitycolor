import { apiClient } from "@/services";

export type WalletRecoveryEvidence = {
  id: number;
  attemptId: number;
  orderId: number | null;
  kind: string;
  mode: "off" | "shadow" | "enforce";
  decision: string;
  providerStatus: string | null;
  providerCode: number | null;
  httpStatus: number | null;
  callbackState: string | null;
  tokenAgeMs: number | null;
  walletAmountIrr: number | null;
  observedAt: string | null;
  createdAt: string | null;
  details: Record<string, unknown> | null;
};

export type WalletRecoveryDiagnostics = {
  attempt: {
    id: number;
    attemptId: string;
    gateway: string;
    status: string;
    providerStatus: string | null;
    nextAction: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    lastReconciledAt: string | null;
    outcome: { kind: string; reason?: string; code?: string };
    wallet: {
      holdStatus: string | null;
      amountIrr: number;
      heldAt: string | null;
      capturedAt: string | null;
      releasedAt: string | null;
      releaseReason: string | null;
      state: string | null;
    };
    lastProviderRead: {
      endpoint: unknown;
      httpStatus: unknown;
      providerCode: unknown;
      successful: unknown;
    };
  } | null;
  evidence: WalletRecoveryEvidence[];
};

/**
 * Read-only operator diagnostics for an order's wallet hold.
 *
 * The evidence rows are what makes an automatic release reviewable after the
 * fact: `provider_response` is overwritten by every later observation, so it
 * cannot answer "why did this money come back".
 */
export const getWalletRecovery = async (
  orderId: number,
): Promise<WalletRecoveryDiagnostics> => {
  const response = await apiClient.get(`/orders/${orderId}/admin/wallet-recovery`);
  return (response as any).data;
};
