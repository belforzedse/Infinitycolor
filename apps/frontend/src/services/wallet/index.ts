import { apiClient } from "../index";
import { CHECKOUT_MAX_RETRIES, CHECKOUT_REQUEST_TIMEOUT_MS } from "@/constants/api";

export interface ChargeIntentResponse {
  success: boolean;
  redirectUrl?: string;
  refId?: string;
  saleOrderId?: string;
  gateway?: string;
  /** Mellat is entered by POSTing its RefId; the others are plain redirects. */
  redirectMethod?: "GET" | "POST";
  formFields?: Record<string, string>;
  reused?: boolean;
  errorCode?: string;
  message?: string;
}

export interface WalletMeResponse {
  success: boolean;
  data?: {
    id?: number | null;
    balance: number; // IRR
    /** Committed to a live checkout and not spendable yet. */
    heldBalance?: number;
    /** balance - heldBalance, in IRR. */
    availableBalance?: number;
    /**
     * Of `heldBalance`, the part held by the named earlier attempt of this
     * customer's — reclaimable by superseding it, so spendable on this
     * checkout even though it is currently held.
     */
    reusableBalance?: number;
    lastTransactionDate?: string;
    description?: string;
  };
}

export interface WalletTopupOptions {
  enabled: boolean;
  disabledReason: "disabled" | "no_gateway" | null;
  gateways: Array<{ code: string; title: string }>;
  minToman: number;
  maxToman: number;
  presetsToman: number[];
  maxPending: number;
}

export interface WalletTopupStatus {
  saleOrderId: string;
  status: "Pending" | "Processing" | "Unknown" | "Success" | "Failed" | "Cancelled";
  gateway: string;
  amountToman: number;
  amountIrr: number;
  createdAt?: string | null;
  expiresAt?: string | null;
  reference?: string | null;
}

export const getMyWallet = async (
  /** An earlier attempt of this customer's whose hold this checkout replaces. */
  reusableAttemptId?: string,
): Promise<WalletMeResponse> => {
  const query = reusableAttemptId
    ? `?reusableAttemptId=${encodeURIComponent(reusableAttemptId)}`
    : "";
  const res = await apiClient.get<WalletMeResponse>(`/local-user-wallet/me${query}`, {
    timeout: CHECKOUT_REQUEST_TIMEOUT_MS,
    retries: CHECKOUT_MAX_RETRIES,
  });
  return res as any;
};

/** What the store will accept right now. Answered even when top-ups are off. */
export const getTopupOptions = async (): Promise<WalletTopupOptions> => {
  const res = await apiClient.get<{ data?: WalletTopupOptions }>("/wallet/topup-options");
  const data = (res as any)?.data;
  return {
    enabled: Boolean(data?.enabled),
    disabledReason: data?.disabledReason ?? null,
    gateways: Array.isArray(data?.gateways) ? data.gateways : [],
    minToman: Number(data?.minToman || 0),
    maxToman: Number(data?.maxToman || 0),
    presetsToman: Array.isArray(data?.presetsToman) ? data.presetsToman : [],
    maxPending: Number(data?.maxPending || 0),
  };
};

/**
 * Opens a payment session.
 *
 * `idempotencyKey` is what makes a double submit — a second tap, a retried
 * request after a dropped response — return the original intent instead of
 * opening a second payment.
 */
export const startTopup = async (params: {
  amountToman: number;
  gateway?: string;
  idempotencyKey?: string;
}): Promise<ChargeIntentResponse> => {
  const res = await apiClient.post<{ data?: ChargeIntentResponse }>(
    "/wallet/charge-intent",
    {
      amountToman: params.amountToman,
      ...(params.gateway ? { gateway: params.gateway } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    },
  );
  const data = (res as any)?.data;
  return {
    success: Boolean(data?.success),
    redirectUrl: data?.redirectUrl,
    refId: data?.refId,
    saleOrderId: data?.saleOrderId,
    gateway: data?.gateway,
    redirectMethod: data?.redirectMethod,
    formFields: data?.formFields,
    reused: data?.reused,
    errorCode: data?.errorCode,
    message: data?.message,
  };
};

/** Owner-scoped status, so the page never has to trust its own query string. */
export const getTopupStatus = async (
  saleOrderId: string,
): Promise<WalletTopupStatus | null> => {
  const res = await apiClient.get<{ data?: { topup?: WalletTopupStatus } }>(
    `/wallet/topups/${encodeURIComponent(saleOrderId)}`,
  );
  return (res as any)?.data?.topup ?? null;
};

export const getMyTopups = async (): Promise<WalletTopupStatus[]> => {
  const res = await apiClient.get<{ data?: { topups?: WalletTopupStatus[] } }>(
    "/wallet/topups",
  );
  return (res as any)?.data?.topups ?? [];
};

export interface WalletTransaction {
  id: number;
  Amount: number;
  Type: "Add" | "Minus";
  Date: string;
  Cause?: string;
  ReferenceId?: string;
  Note?: string;
  Description?: string;
}

export interface WalletTransactionsResponse {
  data: WalletTransaction[];
  meta?: {
    pagination?: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}

export const getWalletTransactions = async (walletId: number): Promise<WalletTransactionsResponse> => {
  const res = await apiClient.get<WalletTransactionsResponse>(
    `/local-user-wallet-transactions?filters[user_wallet][id][$eq]=${walletId}&sort[0]=Date:desc&pagination[pageSize]=100`
  );
  return res as any;
};

export interface AdminWalletResponse {
  success: boolean;
  data?: {
    balanceIrr: number;
    balanceToman: number;
    changed?: boolean;
  };
  errorCode?: string;
  message?: string;
}

export type WalletAdjustMode = "credit" | "debit" | "set";

export const adminGetUserWallet = async (
  userId: number,
): Promise<AdminWalletResponse> => {
  const res = await apiClient.get<AdminWalletResponse>(
    `/local-user-wallet/admin/${userId}`,
  );
  return res as any;
};

export const adminAdjustWallet = async (
  userId: number,
  payload: { mode: WalletAdjustMode; amountToman: number; reason: string },
): Promise<AdminWalletResponse> => {
  const res = await apiClient.post<AdminWalletResponse>(
    "/local-user-wallet/admin/adjust",
    { userId, ...payload },
  );
  return res as any;
};

const WalletService = {
  getMyWallet,
  getTopupOptions,
  startTopup,
  getTopupStatus,
  getMyTopups,
  getWalletTransactions,
  adminGetUserWallet,
  adminAdjustWallet,
};
export default WalletService;
