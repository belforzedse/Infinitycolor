import type { Strapi } from "@strapi/strapi";
import { createHash } from "node:crypto";
import { releaseOrderReservation } from "../../../utils/stockReservations";
import { enqueueSnappayOperation } from "../../../queue/snappay";
import { mapToSnappayCategory } from "./snappay-category-mapper";
import {
  createSnappayAdapter,
  getSnappayConfig,
  type SnappayCallResult,
  type SnappayTokenRequest,
  type SnappayUpdateRequest,
} from "./snappay";
import { claimPaymentAttemptForSnappayInitiation } from "../../payment-attempt/services/claim-payment-attempt";
import {
  buildSnappayPendingDispatch,
  isConsecutiveSnappayGeneration,
  nextSnappayGenerationSeq,
  readSnappayGenerationState,
  rememberedSnappayNonceHashes,
  rememberedSnappayTransactionIds,
  seedSnappayGenerationFromLegacyAttempt,
  snappayCallbackTargetsPreviousGeneration,
  snappayHasInFlightDispatch,
  snappayObservationPatch,
  snappayProviderGenerationIsTerminal,
  snappayProviderPaymentIsUnresolved,
  snappayStoredPaymentPageResume,
  statusMatchesActiveSnappayGeneration,
  withIssuedSnappayToken,
  withSnappayPendingDispatch,
} from "./snappay-generation";
import {
  mergePreviousGenerationCallback,
  mergeSnappayAttemptObservation,
  promoteIssuedSnappayGeneration,
  requeueParkedSnappayReconcile,
  shouldEnqueueSnappayReconcileResume,
} from "../../payment-attempt/services/snappay-attempt-writes";
import {
  displaySnappayFingerprint,
  generateSnappayCallbackNonce,
  generateSnappayTransactionId,
  hashSnappayCallbackNonce,
  isValidSnappayCallbackNonce,
  isValidSnappayTransactionId,
  matchesSnappayCallbackNonce,
  normalizeIranMobile,
  snappayTokenFingerprint,
} from "./snappay-security";
import {
  decideSnappayRecovery,
  normalizeSnappayProviderStatus,
  SNAPPAY_RECONCILIATION_DELAYS_MS,
  type SnappayCallbackState,
  type SnappayProviderStatus,
  type SnappayRecoveryAction,
} from "./snappay-state-machine";
import {
  applySnappayCancellation,
  applySnappayAdminUpdate,
  finalizeSnappaySettlement,
  runSnappaySideEffects,
} from "./snappay-finalization";
import { isSnappayGatewayValue } from "./checkout-gateway-availability";
import {
  gatewayExpectedAmountIrr,
  readPaymentAttemptLegs,
} from "../../payment-attempt/services/payment-legs";
import { planSnappayTenderAdjustment } from "./snappay-split-tender";

const ATTEMPT_UID = "api::payment-attempt.payment-attempt" as const;
const TX_UID = "api::contract-transaction.contract-transaction" as const;
const OPERATION_UID = "api::payment-operation.payment-operation" as const;
const ORDER_UID = "api::order.order" as const;
const CONTRACT_UID = "api::contract.contract" as const;
const OPERATION_LEASE_MS = 5 * 60 * 1000;
/** First reconciler delay after a token is issued. Not a token-replacement window. */
export const SNAPPAY_RESUME_REDIRECT_MAX_AGE_MS = 2 * 60 * 1000;

const SNAPPAY_INITIATION_MESSAGES: Record<string, string> = {
  CHECKOUT_ATTEMPT_CONFLICT:
    "این تلاش پرداخت دیگر معتبر نیست. لطفاً دوباره ثبت سفارش را انتخاب کنید.",
  PAYMENT_IN_PROGRESS:
    "پرداخت قبلی هنوز در حال بررسی است. لطفاً چند لحظه بعد وضعیت سفارش را بررسی کنید.",
  PAYMENT_UNKNOWN:
    "نتیجه شروع پرداخت هنوز مشخص نیست. برای جلوگیری از پرداخت تکراری، وضعیت سفارش را بررسی کنید.",
  SNAPPAY_INVALID_MOBILE:
    "شماره موبایل ثبت‌شده برای پرداخت اقساطی معتبر نیست. لطفاً شماره را در حساب کاربری بررسی کنید و دوباره تلاش کنید.",
  SNAPPAY_AMOUNT_MISMATCH: "مبلغ سفارش با درگاه همخوانی ندارد. لطفاً دوباره تلاش کنید.",
  SNAPPAY_CART_INVALID: "سبد خرید برای اسنپ‌پی نامعتبر است. لطفاً سبد را بررسی و دوباره تلاش کنید.",
  SNAPPAY_TOKEN_DUPLICATE:
    "پرداخت قبلی هنوز در حال بررسی است. برای جلوگیری از پرداخت تکراری، وضعیت سفارش را بررسی کنید.",
};

type InitiateSnappayResult = {
  success: boolean;
  status: "Redirected" | "Failed" | "Unknown";
  orderId: number;
  contractId: number;
  transactionId: string;
  redirectUrl?: string;
  errorCode?: string;
  message?: string;
};

type OperationType =
  | "VERIFY"
  | "SETTLE"
  | "REVERT"
  | "CANCEL"
  | "UPDATE"
  | "RECONCILE"
  | "FINALIZE_EFFECTS";

type AttemptBundle = {
  attempt: any;
  order: any;
  contract: any;
  transaction: any;
};

type OperationObservation = {
  providerStatus?: string;
  httpStatus?: number;
  providerCode?: number;
};

export type SnappayCallbackInput = {
  transactionId: string;
  state: SnappayCallbackState;
  amount: number;
  nonce: string;
};

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`SNAPPAY_CONFIG_INVALID:${name} is required`);
  return value;
}

export function isSnappayHardenedInitiationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(env.SNAPPAY_HARDENED_INITIATION_ENABLED || "")
      .trim()
      .toLowerCase(),
  );
}

export function getSnappayReturnUrl(callbackNonce: string): string {
  if (!isValidSnappayCallbackNonce(callbackNonce)) {
    throw new Error("SNAPPAY_CALLBACK_NONCE_INVALID");
  }
  const value = required("SNAPPAY_RETURN_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SNAPPAY_CONFIG_INVALID:SNAPPAY_RETURN_URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new Error("SNAPPAY_CONFIG_INVALID:SNAPPAY_RETURN_URL must use HTTPS");
  }
  url.searchParams.set("nonce", callbackNonce);
  return url.toString();
}

export function assertSnappayRuntimeConfig(): void {
  getSnappayConfig();
  // Validate the registered static URL without manufacturing a usable nonce.
  const returnUrl = new URL(required("SNAPPAY_RETURN_URL"));
  if (returnUrl.protocol !== "https:") {
    throw new Error("SNAPPAY_CONFIG_INVALID:SNAPPAY_RETURN_URL must use HTTPS");
  }
}

export function paymentResultUrl(orderId?: number, resultHint = "processing"): string {
  const base = String(
    process.env.FRONTEND_BASE_URL || process.env.FRONTEND_URL || "https://infinitycolor.co",
  ).replace(/\/$/, "");
  const url = new URL(`${base}/payment/result`);
  if (orderId) url.searchParams.set("orderId", String(orderId));
  url.searchParams.set("resultHint", resultHint);
  return url.toString();
}

function providerSummary<T>(result: SnappayCallResult<T>) {
  return {
    endpoint: result.diagnostic.endpoint,
    successful: result.successful,
    httpStatus: result.diagnostic.httpStatus,
    providerCode: result.diagnostic.providerCode,
    timedOut: result.diagnostic.timedOut === true,
    transportError: result.diagnostic.transportError === true,
  };
}

export function extractSnappayPaymentTokenFromRedirectUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  const token = String(url.searchParams.get("paymentToken") || "").trim();
  if (!token || token.length > 255 || /\s/.test(token)) return "";
  return token;
}

async function resolveSnappayPaymentTokenForOperation(
  strapi: Strapi,
  bundle: AttemptBundle,
  operation: { metadata?: Record<string, unknown> },
): Promise<string> {
  const metaTx = String(operation.metadata?.transactionId || "").trim();
  const state = readSnappayGenerationState(bundle.attempt.providerResponse);
  if (metaTx && state.previousGeneration?.transactionId === metaTx) {
    return String(state.previousGeneration.paymentToken || "").trim();
  }
  return resolveSnappayPaymentToken(strapi, bundle);
}

async function resolveSnappayPaymentToken(strapi: Strapi, bundle: AttemptBundle): Promise<string> {
  // Current generation only. An in-flight pendingDispatch means a replacement
  // mint is unresolved — do not observe TrackId from a prior generation.
  if (snappayHasInFlightDispatch(bundle.attempt.providerResponse)) {
    return "";
  }
  const stored = String(bundle.transaction.TrackId || "").trim();
  if (stored) return stored;

  const recovered = extractSnappayPaymentTokenFromRedirectUrl(bundle.attempt.redirectUrl);
  if (!recovered) return "";

  const expectedFingerprint = String(
    bundle.attempt.providerResponse?.tokenFingerprint || "",
  ).trim();
  const actualFingerprint = displaySnappayFingerprint(snappayTokenFingerprint(recovered));
  if (expectedFingerprint && expectedFingerprint !== actualFingerprint) {
    strapi.log.error("Refused mismatched SnappPay token recovery", {
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order.id,
      transactionId: bundle.attempt.providerReference,
    });
    return "";
  }

  await strapi.db.query(TX_UID).update({
    where: { id: bundle.transaction.id },
    data: { TrackId: recovered },
  } as any);
  bundle.transaction.TrackId = recovered;
  strapi.log.warn("Recovered missing SnappPay payment token", {
    attemptId: bundle.attempt.attemptId,
    orderId: bundle.order.id,
    transactionId: bundle.attempt.providerReference,
    tokenFingerprint: actualFingerprint,
  });
  return recovered;
}

function isAmbiguousResult<T>(result: SnappayCallResult<T>): boolean {
  // Transport failure, timeout, and 5xx are unreadable — those must never
  // mint a second token. Parsed 1007/1009/1048 are readable investigation
  // outcomes, not proof the payment is unpaid.
  return (
    result.diagnostic.timedOut === true ||
    result.diagnostic.transportError === true ||
    Number(result.diagnostic.httpStatus || 0) >= 500
  );
}

function readTokenAttemptSeq(bundle: AttemptBundle): number {
  const raw = Number(bundle.attempt?.providerResponse?.tokenAttemptSeq || 0);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

function mergeAttemptProviderResponse(
  bundle: AttemptBundle,
  result: SnappayCallResult<any>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const previous =
    bundle.attempt?.providerResponse && typeof bundle.attempt.providerResponse === "object"
      ? bundle.attempt.providerResponse
      : {};
  return {
    ...previous,
    ...providerSummary(result),
    ...extra,
  };
}

function initiationMessage(code: string, fallback?: string): string {
  return (
    SNAPPAY_INITIATION_MESSAGES[code] || fallback || SNAPPAY_INITIATION_MESSAGES.PAYMENT_UNKNOWN
  );
}

function redirectedInitiation(
  bundle: AttemptBundle,
  redirectUrl: string,
  transactionId?: string,
): InitiateSnappayResult {
  return {
    success: true,
    status: "Redirected",
    orderId: Number(bundle.order.id),
    contractId: Number(bundle.contract.id),
    transactionId: String(transactionId || bundle.attempt.providerReference || ""),
    redirectUrl,
  };
}

function failedInitiation(
  bundle: AttemptBundle,
  errorCode: string,
  status: "Failed" | "Unknown" = "Failed",
  message?: string,
): InitiateSnappayResult {
  return {
    success: false,
    status,
    orderId: Number(bundle.order.id),
    contractId: Number(bundle.contract.id),
    transactionId: String(bundle.attempt.providerReference || ""),
    errorCode,
    message: initiationMessage(errorCode, message),
  };
}

function hasValidatedOkCallback(bundle: AttemptBundle): boolean {
  return (
    String(bundle.attempt.providerStatus || "") === "CALLBACK_OK" ||
    String(bundle.attempt.nextAction || "") === "verify"
  );
}

function hasFailedCallback(bundle: AttemptBundle): boolean {
  return (
    String(bundle.attempt.providerStatus || "") === "CALLBACK_FAILED" ||
    String(bundle.attempt.nextAction || "") === "reconcile_failed_callback"
  );
}

function orderCanReceiveReplacementGeneration(bundle: AttemptBundle): boolean {
  return (
    String(bundle.order.Status || "") === "Paying" &&
    String(bundle.order.ReservationStatus || "") === "Reserved"
  );
}

function operationObservation<T>(
  result: SnappayCallResult<T>,
  providerStatus?: string,
): OperationObservation {
  return {
    ...(providerStatus ? { providerStatus } : {}),
    ...(Number.isInteger(result.diagnostic.httpStatus)
      ? { httpStatus: result.diagnostic.httpStatus }
      : {}),
    ...(Number.isInteger(result.diagnostic.providerCode)
      ? { providerCode: result.diagnostic.providerCode }
      : {}),
  };
}

async function loadAttemptBundle(
  strapi: Strapi,
  where: Record<string, unknown>,
  options: { orderBy?: Record<string, unknown> } = {},
): Promise<AttemptBundle | null> {
  const attempt: any = await strapi.db.query(ATTEMPT_UID).findOne({
    where,
    ...(options.orderBy ? { orderBy: options.orderBy } : {}),
    populate: {
      order: {
        populate: {
          user: true,
          order_items: {
            populate: {
              product_variation: {
                populate: {
                  product_stock: true,
                  product: {
                    populate: { product_main_category: true },
                  },
                },
              },
            },
          },
        },
      },
      contract: {
        populate: {
          contract_transactions: true,
        },
      },
    },
  } as any);
  if (!attempt) return null;
  const order = attempt.order;
  const contract = attempt.contract;
  const transactions = Array.isArray(contract?.contract_transactions)
    ? contract.contract_transactions
    : [];
  const snappayTransactions = [...transactions]
    .reverse()
    .filter((candidate: { external_source?: unknown; external_id?: unknown }) =>
      isSnappayGatewayValue(candidate?.external_source),
    );
  const rememberedIds = new Set([
    String(attempt.providerReference || ""),
    ...rememberedSnappayTransactionIds(attempt),
  ]);
  const transaction =
    snappayTransactions.find((candidate) =>
      rememberedIds.has(String(candidate?.external_id || "")),
    ) || snappayTransactions[0];
  if (!order || !contract || !transaction) return null;
  return { attempt, order, contract, transaction };
}

async function findAttemptByTransactionId(
  strapi: Strapi,
  transactionId: string,
): Promise<AttemptBundle | null> {
  const byReference = await loadAttemptBundle(strapi, {
    Gateway: "snappay",
    providerReference: transactionId,
  });
  if (byReference) return byReference;

  const raw = await strapi.db.connection?.raw?.(
    `SELECT id FROM payment_attempts
     WHERE gateway = 'snappay'
       AND (
         provider_reference = ?
         OR provider_response->>'pendingTransactionId' = ?
         OR provider_response->'pendingDispatch'->>'transactionId' = ?
         OR provider_response->'generation'->>'transactionId' = ?
         OR provider_response->'previousGeneration'->>'transactionId' = ?
       )
     ORDER BY id DESC
     LIMIT 1`,
    [transactionId, transactionId, transactionId, transactionId, transactionId],
  );
  const id = Number(raw?.rows?.[0]?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return loadAttemptBundle(strapi, { id, Gateway: "snappay" });
}

async function resolveCustomerMobile(
  strapi: Strapi,
  userId: number,
  supplied: unknown,
): Promise<string> {
  const suppliedMobile = normalizeIranMobile(supplied);
  if (suppliedMobile) return suppliedMobile;
  const localUser: any = await strapi.db
    .query("api::local-user.local-user")
    .findOne({ where: { id: userId } } as any);
  return normalizeIranMobile(localUser?.Phone);
}

async function buildTokenPayload(
  strapi: Strapi,
  bundle: AttemptBundle,
  mobileInput: unknown,
  callbackNonce: string,
): Promise<SnappayTokenRequest> {
  const mobile = await resolveCustomerMobile(
    strapi,
    Number(bundle.order?.user?.id ?? bundle.order?.user),
    mobileInput,
  );
  if (!/^\+98\d{10}$/.test(mobile)) {
    throw new Error("SNAPPAY_INVALID_MOBILE");
  }
  const items = await Promise.all(
    (bundle.order.order_items || []).map(async (item: any) => {
      const variation = item?.product_variation;
      const categoryEntity = variation?.product?.product_main_category;
      const category = await mapToSnappayCategory(
        strapi,
        categoryEntity?.snappay_category || categoryEntity?.Title || categoryEntity?.Name || "",
      );
      return {
        amount: Math.round(Number(item.PerAmount || 0) * 10),
        category,
        count: Math.round(Number(item.Count || 0)),
        id: Number(variation?.id || item.id),
        name: String(item.ProductTitle || variation?.product?.Title || "Item").slice(0, 255),
        commissionType: 100,
      };
    }),
  );
  if (
    items.length === 0 ||
    items.some(
      (item) =>
        item.amount < 0 ||
        item.count <= 0 ||
        !Number.isInteger(item.amount) ||
        !Number.isInteger(item.count),
    )
  ) {
    throw new Error("SNAPPAY_CART_INVALID");
  }

  const summary = bundle.attempt.quoteSnapshot?.financialSummary || {};
  const shippingAmount = Math.round(Number(summary.shipping || 0) * 10);
  const discountAmount = Math.round(Number(summary.discount || 0) * 10);
  const totalAmount =
    items.reduce((sum, item) => sum + item.amount * item.count, 0) + shippingAmount;
  const legs = readPaymentAttemptLegs(bundle.attempt);
  const amount = legs.gatewayIrr;
  const externalSourceAmount = legs.walletIrr;
  if (
    amount <= 0 ||
    legs.totalIrr !== totalAmount - discountAmount ||
    amount + externalSourceAmount !== legs.totalIrr
  ) {
    throw new Error("SNAPPAY_AMOUNT_MISMATCH");
  }

  return {
    amount,
    discountAmount,
    externalSourceAmount,
    mobile,
    returnURL: getSnappayReturnUrl(callbackNonce),
    transactionId: String(bundle.attempt.providerReference),
    // Omitting paymentMethodTypeDto and forcedPaymentMethodTypes deliberately
    // preserves all currently active/eligible SnappPay payment methods.
    cartList: [
      {
        cartId: Number(bundle.order.id),
        cartItems: items,
        isShipmentIncluded: true,
        isTaxIncluded: true,
        taxAmount: 0,
        shippingAmount,
        totalAmount,
      },
    ],
  };
}

async function buildAdminUpdatePayload(
  strapi: Strapi,
  bundle: AttemptBundle,
  paymentToken: string,
  metadata: any,
): Promise<SnappayUpdateRequest> {
  const changes = Array.isArray(metadata?.changes) ? metadata.changes : [];
  if (changes.length === 0) {
    throw new Error("SNAPPAY_OPERATOR_CHANGES_REQUIRED");
  }
  const itemById = new Map(
    (bundle.order.order_items || []).map((item: any) => [Number(item.id), item]),
  );
  const seenItemIds = new Set<number>();
  for (const change of changes) {
    const orderItemId = Number(change?.orderItemId);
    const oldCount = Number(change?.oldCount);
    const newCount = Number(change?.newCount);
    const restockDelta = Number(change?.restockDelta);
    const item: any = itemById.get(orderItemId);
    if (
      !Number.isInteger(orderItemId) ||
      orderItemId <= 0 ||
      seenItemIds.has(orderItemId) ||
      !item ||
      !Number.isInteger(oldCount) ||
      !Number.isInteger(newCount) ||
      !Number.isInteger(restockDelta) ||
      oldCount <= 0 ||
      newCount < 0 ||
      newCount > oldCount ||
      restockDelta !== oldCount - newCount ||
      Number(item.Count) !== oldCount
    ) {
      throw new Error("SNAPPAY_ADMIN_UPDATE_ITEMS_CHANGED");
    }
    seenItemIds.add(orderItemId);
  }
  const changeMap = new Map<number, number>(
    changes.map((change: any) => [Number(change.orderItemId), Number(change.newCount)]),
  );
  const retainedItems = (bundle.order.order_items || []).filter((item: any) => {
    const next = changeMap.get(Number(item.id));
    return next === undefined || next > 0;
  });
  if (retainedItems.length === 0) {
    throw new Error("SNAPPAY_UPDATE_REQUIRES_CANCEL");
  }
  const cartItems = await Promise.all(
    retainedItems.map(async (item: any) => {
      const nextCount = changeMap.get(Number(item.id)) ?? Number(item.Count || 0);
      const variation = item?.product_variation;
      const categoryEntity = variation?.product?.product_main_category;
      return {
        id: Number(variation?.id || item.id),
        name: String(item.ProductTitle || variation?.product?.Title || "Item").slice(0, 255),
        category: await mapToSnappayCategory(
          strapi,
          categoryEntity?.snappay_category || categoryEntity?.Title || categoryEntity?.Name || "",
        ),
        amount: Math.round(Number(item.PerAmount || 0) * 10),
        count: Number(nextCount),
        commissionType: 100,
      };
    }),
  );
  const requestedTotalIrr = Math.round(Number(metadata.newTotalToman || 0) * 10);
  const discountAmount = Math.round(Number(metadata.newDiscountToman || 0) * 10);
  const shippingAmount = Math.round(Number(metadata.newShippingToman || 0) * 10);
  const totalAmount =
    cartItems.reduce((sum, item) => sum + Number(item.amount) * Number(item.count), 0) +
    shippingAmount;
  const expectedOldTotalToman = Number(metadata.expectedOldTotalToman);
  if (
    !Number.isInteger(Number(metadata.newTotalToman)) ||
    !Number.isInteger(Number(metadata.newDiscountToman)) ||
    !Number.isInteger(Number(metadata.newShippingToman)) ||
    !Number.isInteger(expectedOldTotalToman) ||
    requestedTotalIrr < 0 ||
    discountAmount < 0 ||
    shippingAmount < 0 ||
    requestedTotalIrr > Number(bundle.attempt.Amount) ||
    Number(bundle.contract.Amount) !== expectedOldTotalToman ||
    cartItems.some(
      (item) =>
        !Number.isInteger(item.amount) ||
        item.amount < 0 ||
        !Number.isInteger(item.count) ||
        item.count <= 0,
    ) ||
    requestedTotalIrr !== totalAmount - discountAmount
  ) {
    throw new Error("SNAPPAY_ADMIN_UPDATE_AMOUNT_MISMATCH");
  }
  const tender = planSnappayTenderAdjustment({
    attempt: bundle.attempt,
    transactions: bundle.contract.contract_transactions || [],
    expectedOldTotalToman,
    newTotalToman: Number(metadata.newTotalToman),
  });
  return {
    paymentToken,
    amount: tender.gatewayRemainingIrr,
    discountAmount,
    externalSourceAmount: tender.walletRemainingIrr,
    cartList: [
      {
        cartId: Number(bundle.order.id),
        cartItems,
        isShipmentIncluded: true,
        isTaxIncluded: true,
        taxAmount: 0,
        shippingAmount,
        totalAmount,
      },
    ],
  };
}

async function updateProviderObservation(
  strapi: Strapi,
  bundle: AttemptBundle,
  result: SnappayCallResult<any>,
  providerStatus?: SnappayProviderStatus,
): Promise<void> {
  const patch = snappayObservationPatch(result);
  const state = readSnappayGenerationState(bundle.attempt.providerResponse);
  const generationSeq = state.generation?.seq || state.tokenAttemptSeq || 0;
  const generationTransactionId = String(
    state.generation?.transactionId || bundle.attempt.providerReference || "",
  );
  const existingProviderStatus = String(bundle.attempt.providerStatus || "");
  const writeProviderStatus =
    existingProviderStatus.startsWith("CALLBACK_") &&
    (!providerStatus || providerStatus === "UNKNOWN")
      ? undefined
      : providerStatus;
  const generationTerminalEvidence =
    (providerStatus === "REVERT" || providerStatus === "CANCEL") && state.generation
      ? providerStatus
      : undefined;
  const written = await mergeSnappayAttemptObservation(strapi, {
    attemptId: Number(bundle.attempt.id),
    transactionId: Number(bundle.transaction.id),
    patch,
    ...(writeProviderStatus ? { providerStatus: writeProviderStatus } : {}),
    generationSeq,
    generationTransactionId,
    httpStatus: result.diagnostic.httpStatus,
    providerCode: result.diagnostic.providerCode,
    ...(generationTerminalEvidence ? { generationTerminalEvidence } : {}),
  });
  if (!written) {
    strapi.log.warn("Refused stale SnappPay observation write", {
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order.id,
      generationSeq,
      transactionId: generationTransactionId,
    });
    return;
  }
  const previous =
    bundle.attempt?.providerResponse && typeof bundle.attempt.providerResponse === "object"
      ? bundle.attempt.providerResponse
      : {};
  const nextGeneration =
    generationTerminalEvidence && state.generation
      ? { ...state.generation, terminalEvidence: generationTerminalEvidence }
      : state.generation;
  bundle.attempt.providerResponse = {
    ...previous,
    ...patch,
    ...(nextGeneration ? { generation: nextGeneration } : {}),
    ...(state.previousGeneration ? { previousGeneration: state.previousGeneration } : {}),
    ...(state.pendingDispatch ? { pendingDispatch: state.pendingDispatch } : {}),
    ...(state.tokenAttemptSeq ? { tokenAttemptSeq: state.tokenAttemptSeq } : {}),
  };
  if (writeProviderStatus) {
    bundle.transaction.GatewayStatus = writeProviderStatus;
    bundle.attempt.providerStatus = writeProviderStatus;
  }
}

async function failInitiation(
  strapi: Strapi,
  bundle: AttemptBundle,
  code: string,
  message: string,
): Promise<void> {
  await strapi.db.transaction(async ({ trx }) => {
    await releaseOrderReservation(strapi, Number(bundle.order.id), "Released", trx);
    const now = new Date();
    await strapi.db.query(ORDER_UID).update({
      where: { id: bundle.order.id },
      data: { Status: "Cancelled" },
      transacting: trx,
    } as any);
    await strapi.db.query(CONTRACT_UID).update({
      where: { id: bundle.contract.id },
      data: { Status: "Failed" },
      transacting: trx,
    } as any);
    await strapi.db.query(TX_UID).update({
      where: { id: bundle.transaction.id },
      data: {
        Status: "Failed",
        GatewayStatus: code,
        GatewayResponse: { code },
      },
      transacting: trx,
    } as any);
    await strapi.db.query(ATTEMPT_UID).update({
      where: { id: bundle.attempt.id },
      data: {
        Status: "Failed",
        providerStatus: code,
        failureCode: code,
        failureMessage: message.slice(0, 500),
        nextAction: null,
        nextActionAt: null,
        leaseUntil: null,
        resolvedAt: now,
      },
      transacting: trx,
    } as any);
  });
}

async function markAttemptUnknown(
  strapi: Strapi,
  bundle: AttemptBundle,
  code: string,
  message: string,
  nextActionAt?: Date,
  nextAction = "manual_review",
): Promise<void> {
  await strapi.db.transaction(async ({ trx }) => {
    await strapi.db.query(ATTEMPT_UID).update({
      where: { id: bundle.attempt.id },
      data: {
        Status: "Unknown",
        providerStatus: "UNKNOWN",
        failureCode: code,
        failureMessage: message.slice(0, 500),
        nextAction,
        nextActionAt: nextActionAt || null,
        lastReconciledAt: new Date(),
      },
      transacting: trx,
    } as any);
    await strapi.db.query(TX_UID).update({
      where: { id: bundle.transaction.id },
      data: {
        GatewayStatus: "UNKNOWN",
        GatewayResponse: { code },
        LastReconciledAt: new Date(),
      },
      transacting: trx,
    } as any);
    if (bundle.order.ReservationStatus === "Reserved") {
      const extension = new Date(Date.now() + 30 * 60 * 1000);
      await strapi.db.query(ORDER_UID).update({
        where: { id: bundle.order.id },
        data: { ReservedUntil: extension },
        transacting: trx,
      } as any);
    }
  });
}

async function recordTokenOperation(
  strapi: Strapi,
  bundle: AttemptBundle,
  status: "Succeeded" | "Failed" | "Unknown",
  result: SnappayCallResult<any>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const key = `token:${bundle.attempt.id}`;
  const existing: any = await strapi.db.query(OPERATION_UID).findOne({
    where: { idempotencyKey: key },
  } as any);
  const data = {
    idempotencyKey: key,
    OperationType: "TOKEN",
    Status: status,
    httpStatus: result.diagnostic.httpStatus,
    providerCode: result.diagnostic.providerCode,
    retryCount: 0,
    metadata: {
      ...providerSummary(result),
      ...extra,
    },
    attemptKey: bundle.attempt.id,
    payment_attempt: bundle.attempt.id,
    order: bundle.order.id,
    contract_transaction: bundle.transaction.id,
  };
  if (existing) {
    await strapi.db.query(OPERATION_UID).update({ where: { id: existing.id }, data } as any);
  } else {
    await strapi.db.query(OPERATION_UID).create({ data } as any);
  }
}

export async function checkSnappayEligibility(strapi: Strapi, amountIrr: number): Promise<void> {
  if (!isSnappayHardenedInitiationEnabled()) {
    throw new Error("SNAPPAY_HARDENED_INITIATION_DISABLED");
  }
  assertSnappayRuntimeConfig();
  if (!Number.isInteger(amountIrr) || amountIrr <= 0) {
    throw new Error("SNAPPAY_AMOUNT_INVALID");
  }
  const result = await createSnappayAdapter(strapi).eligible(amountIrr);
  if (!result.successful || result.response?.eligible !== true) {
    const code = result.diagnostic.providerCode || "UNAVAILABLE";
    throw new Error(`SNAPPAY_INELIGIBLE:${code}`);
  }
}

async function enqueueImmediateReconciliation(strapi: Strapi, bundle: AttemptBundle) {
  const key = `reconcile:${bundle.attempt.id}`;
  const existing: any = await strapi.db.query(OPERATION_UID).findOne({
    where: { idempotencyKey: key },
  } as any);
  if (existing?.Status === "Succeeded" || existing?.Status === "Processing") {
    return existing;
  }
  const nextRunAt = new Date();
  const operation = existing
    ? await strapi.db.query(OPERATION_UID).update({
        where: { id: existing.id },
        data: {
          Status: "Queued",
          nextRunAt,
          leaseUntil: null,
        },
      } as any)
    : await strapi.db.query(OPERATION_UID).create({
        data: {
          idempotencyKey: key,
          OperationType: "RECONCILE",
          Status: "Queued",
          retryCount: 0,
          nextRunAt,
          metadata: { reason: "checkout_status_fulfill" },
          attemptKey: bundle.attempt.id,
          payment_attempt: bundle.attempt.id,
          order: bundle.order.id,
          contract_transaction: bundle.transaction.id,
        },
      } as any);
  await enqueueSnappayOperation(Number(operation.id), Number(operation.retryCount || 0), 0);
  return operation;
}

async function persistIssuedToken(
  strapi: Strapi,
  bundle: AttemptBundle,
  result: SnappayCallResult<{ paymentToken: string; paymentPageUrl: string }>,
  transactionId: string,
  callbackNonce: string,
  tokenAttemptSeq: number,
  leaseVersion: number,
): Promise<boolean> {
  const paymentToken = String(result.response?.paymentToken || "");
  const paymentPageUrl = String(result.response?.paymentPageUrl || "");
  const tokenHash = snappayTokenFingerprint(paymentToken);
  const fingerprint = displaySnappayFingerprint(tokenHash);
  const callbackNonceHash = hashSnappayCallbackNonce(callbackNonce);
  const pending = readSnappayGenerationState(bundle.attempt.providerResponse).pendingDispatch;
  if (
    !pending ||
    pending.seq !== tokenAttemptSeq ||
    pending.transactionId !== transactionId ||
    pending.callbackNonceHash !== callbackNonceHash
  ) {
    strapi.log.error("SnappPay issued token did not match the pending dispatch", {
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order.id,
      seq: tokenAttemptSeq,
    });
    return false;
  }
  const providerResponse = mergeAttemptProviderResponse(
    bundle,
    result,
    withIssuedSnappayToken(bundle.attempt.providerResponse, {
      seq: tokenAttemptSeq,
      transactionId,
      callbackNonceHash,
      paymentTokenFingerprint: fingerprint,
      paymentToken,
    }),
  );
  strapi.log.info(
    `SnappPay persisted token identity ${JSON.stringify({
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order.id,
      seq: tokenAttemptSeq,
      tokenFingerprint: fingerprint,
      tokenLength: paymentToken.length,
      pageUrlLength: paymentPageUrl.length,
    })}`,
  );
  const installed = await strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [bundle.attempt.id]);
    return promoteIssuedSnappayGeneration(strapi, {
      attemptId: Number(bundle.attempt.id),
      transactionId: Number(bundle.transaction.id),
      contractId: Number(bundle.contract.id),
      leaseVersion,
      pendingSeq: pending.seq,
      pendingTransactionId: pending.transactionId,
      pendingCallbackNonceHash: pending.callbackNonceHash,
      paymentToken,
      paymentPageUrl,
      callbackNonce,
      callbackNonceHash,
      providerResponse,
      gatewayResponse: {
        ...providerSummary(result),
        tokenFingerprint: fingerprint,
      },
      httpStatus: result.diagnostic.httpStatus,
      providerCode: result.diagnostic.providerCode,
      trx,
    });
  });
  if (!installed) {
    await recordTokenOperation(strapi, bundle, "Unknown", result, {
      transactionId,
      tokenFingerprint: fingerprint,
      seq: tokenAttemptSeq,
      ownership: "pending_dispatch_mismatch",
    });
    return false;
  }
  bundle.attempt.Status = "Redirected";
  bundle.attempt.providerStatus = "PENDING";
  bundle.attempt.providerReference = transactionId;
  bundle.attempt.redirectUrl = paymentPageUrl;
  bundle.attempt.providerResponse = providerResponse;
  bundle.attempt.callbackNonceHash = callbackNonceHash;
  bundle.transaction.TrackId = paymentToken;
  bundle.transaction.external_id = transactionId;
  await recordTokenOperation(strapi, bundle, "Succeeded", result, {
    transactionId,
    tokenFingerprint: fingerprint,
    seq: tokenAttemptSeq,
  });
  await createOrReuseOperation(strapi, bundle, {
    type: "RECONCILE",
    idempotencyKey: `reconcile:${bundle.attempt.id}`,
    delayMs: SNAPPAY_RESUME_REDIRECT_MAX_AGE_MS,
  });
  return true;
}

async function persistPendingSnappayDispatch(
  strapi: Strapi,
  bundle: AttemptBundle,
  input: {
    seq: number;
    transactionId: string;
    callbackNonce: string;
  },
): Promise<void> {
  const callbackNonceHash = hashSnappayCallbackNonce(input.callbackNonce);
  const seeded = seedSnappayGenerationFromLegacyAttempt({
    providerResponse: bundle.attempt.providerResponse,
    transactionId: bundle.attempt.providerReference,
    callbackNonceHash: bundle.attempt.callbackNonceHash,
    paymentToken: bundle.transaction.TrackId,
    redirectedAt: bundle.attempt.redirectedAt,
    providerStatus: bundle.attempt.providerStatus,
  });
  const pending = buildSnappayPendingDispatch({
    seq: input.seq,
    transactionId: input.transactionId,
    callbackNonceHash,
  });
  const providerResponse = withSnappayPendingDispatch(seeded, pending);
  await strapi.db.query(ATTEMPT_UID).update({
    where: { id: bundle.attempt.id },
    data: {
      providerReference: input.transactionId,
      callbackNonce: input.callbackNonce,
      callbackNonceHash,
      providerResponse,
    },
  } as any);
  bundle.attempt.providerReference = input.transactionId;
  bundle.attempt.callbackNonce = input.callbackNonce;
  bundle.attempt.callbackNonceHash = callbackNonceHash;
  bundle.attempt.providerResponse = providerResponse;
}

async function refreshReservedUntilOnResume(strapi: Strapi, bundle: AttemptBundle): Promise<void> {
  if (String(bundle.order?.ReservationStatus || "") !== "Reserved") return;
  const reservationTtlMinutes = Number(process.env.STOCK_RESERVATION_TTL_MINUTES || 30);
  const reservationTtlMs = Number.isFinite(reservationTtlMinutes)
    ? Math.max(1, reservationTtlMinutes) * 60 * 1000
    : 30 * 60 * 1000;
  const reservedUntil = new Date(Date.now() + reservationTtlMs);
  await strapi.db.query(ORDER_UID).update({
    where: {
      id: bundle.order.id,
      ReservationStatus: "Reserved",
    },
    data: { ReservedUntil: reservedUntil },
  } as any);
  bundle.order.ReservedUntil = reservedUntil;
}

async function clearSnappayInitiationLease(strapi: Strapi, bundle: AttemptBundle): Promise<void> {
  await strapi.db.query(ATTEMPT_UID).update({
    where: { id: bundle.attempt.id },
    data: { leaseUntil: null },
  } as any);
}

async function resumeExistingPaymentPage(
  strapi: Strapi,
  bundle: AttemptBundle,
  resumeUrl: string,
  options: { refreshReservation?: boolean } = {},
): Promise<InitiateSnappayResult> {
  // Observe/resume must not clear leaseUntil. Another request may hold the
  // exclusive mint lease (POST /token / retarget); only that holder — or
  // terminal fail/unknown paths after a claim — may release it.
  if (options.refreshReservation !== false) {
    await refreshReservedUntilOnResume(strapi, bundle).catch((error: unknown) => {
      strapi.log.warn("Failed to refresh stock reservation on SnappPay resume", {
        attemptId: bundle.attempt.attemptId,
        orderId: bundle.order.id,
        error: String((error as Error)?.message || error).slice(0, 300),
      });
    });
  }
  return redirectedInitiation(bundle, resumeUrl);
}

async function requestSnappayToken(
  strapi: Strapi,
  bundle: AttemptBundle,
  input: { callbackNonce: string; mobile?: string; retarget: boolean },
): Promise<InitiateSnappayResult> {
  // Exclusive lease only around mint / retarget. Observe of an existing token
  // never enters here, so a back-button retry can GET /status while another
  // caller still holds the lease from a prior token request.
  const claimed = await claimPaymentAttemptForSnappayInitiation(strapi, Number(bundle.attempt.id));
  if (!claimed) {
    return failedInitiation(bundle, "PAYMENT_IN_PROGRESS", "Unknown");
  }

  if (snappayHasInFlightDispatch(bundle.attempt.providerResponse)) {
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  const previousSeq = readTokenAttemptSeq(bundle);
  if (input.retarget) {
    if (!snappayProviderGenerationIsTerminal(bundle.attempt)) {
      await markAttemptUnknown(
        strapi,
        bundle,
        "SNAPPAY_RETARGET_NOT_TERMINAL",
        "Refusing a replacement token while the earlier SnappPay generation is unresolved",
        undefined,
        "reconcile",
      );
      return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
    }
    if (!orderCanReceiveReplacementGeneration(bundle)) {
      await markAttemptUnknown(
        strapi,
        bundle,
        "SNAPPAY_RETARGET_ORDER_UNUSABLE",
        "The checkout order cannot receive another SnappPay generation",
        undefined,
        "reconcile",
      );
      return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
    }
  } else if (previousSeq > 0) {
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_TOKEN_UNRESOLVED",
      "A previous SnappPay token request has no stored payment token",
      undefined,
      "reconcile",
    );
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  const nextSeq = nextSnappayGenerationSeq(previousSeq);
  if (!isConsecutiveSnappayGeneration(previousSeq, nextSeq)) {
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_GENERATION_SKIP",
      "Refusing to skip a SnappPay payment generation",
      undefined,
      "manual_review",
    );
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  const transactionId = input.retarget
    ? generateSnappayTransactionId()
    : String(bundle.attempt.providerReference || "");
  const callbackNonce = input.retarget ? generateSnappayCallbackNonce() : input.callbackNonce;
  if (!isValidSnappayTransactionId(transactionId)) {
    await failInitiation(
      strapi,
      bundle,
      "SNAPPAY_TRANSACTION_ID_INVALID",
      "SnappPay transaction id is invalid",
    );
    return failedInitiation(bundle, "SNAPPAY_TRANSACTION_ID_INVALID");
  }

  const previousReference = bundle.attempt.providerReference;
  bundle.attempt.providerReference = transactionId;
  let payload: SnappayTokenRequest;
  try {
    payload = await buildTokenPayload(strapi, bundle, input.mobile, callbackNonce);
  } catch (error: unknown) {
    bundle.attempt.providerReference = previousReference;
    const code = String((error as Error)?.message || "SNAPPAY_PAYLOAD_INVALID").split(":")[0];
    await failInitiation(strapi, bundle, code, "SnappPay request data is invalid");
    return failedInitiation(bundle, code);
  }

  try {
    await persistPendingSnappayDispatch(strapi, bundle, {
      seq: nextSeq,
      transactionId,
      callbackNonce,
    });
  } catch (error: unknown) {
    bundle.attempt.providerReference = previousReference;
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_TOKEN_UNRESOLVED",
      "Could not persist the SnappPay token candidate before calling the provider",
      undefined,
      "reconcile",
    );
    strapi.log.error("SnappPay pending dispatch persist failed", {
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order.id,
      error: String((error as Error)?.message || error).slice(0, 300),
    });
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  const result = await createSnappayAdapter(strapi).requestPaymentToken(payload);
  if (!result.successful || !result.response?.paymentToken || !result.response?.paymentPageUrl) {
    const providerCode = Number(result.diagnostic.providerCode || 0);
    if (providerCode === 1009) {
      await recordTokenOperation(strapi, bundle, "Unknown", result);
      const storedTrackId = String(bundle.transaction.TrackId || "").trim();
      const storedToken = await resolveSnappayPaymentToken(strapi, bundle);
      if (storedToken) {
        // We hold the mint lease from this requestSnappayToken claim. Observe
        // intentionally does not clear leases (another tab may be minting), so
        // release ours after the status/resume path returns.
        const observed = await observeExistingSnappayToken(strapi, bundle, storedToken, {
          allowRetarget: false,
          mobile: input.mobile,
          callbackNonce,
          storedTrackId,
        });
        await clearSnappayInitiationLease(strapi, bundle);
        return observed;
      }
      await markAttemptUnknown(
        strapi,
        bundle,
        "SNAPPAY_TOKEN_1009",
        "SnappPay reported a duplicate transaction without a stored token for this generation",
        undefined,
        "reconcile",
      );
      return failedInitiation(bundle, "SNAPPAY_TOKEN_DUPLICATE", "Unknown");
    }
    const code = `SNAPPAY_TOKEN_${providerCode || result.diagnostic.httpStatus || "FAILED"}`;
    await markAttemptUnknown(
      strapi,
      bundle,
      code,
      result.errorData?.message || "SnappPay token request result is unresolved",
      undefined,
      "reconcile",
    );
    await recordTokenOperation(
      strapi,
      bundle,
      isAmbiguousResult(result) ? "Unknown" : "Failed",
      result,
    );
    strapi.log.error("SnappPay token initiation did not return a usable token", {
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order.id,
      transactionId,
      ...providerSummary(result),
    });
    return failedInitiation(
      bundle,
      isAmbiguousResult(result) ? "PAYMENT_UNKNOWN" : code,
      "Unknown",
    );
  }

  const installed = await persistIssuedToken(
    strapi,
    bundle,
    result,
    transactionId,
    callbackNonce,
    nextSeq,
    claimed.leaseVersion,
  );
  if (!installed) {
    const fresh = await loadAttemptBundle(strapi, { id: bundle.attempt.id });
    const storedToken = fresh ? await resolveSnappayPaymentToken(strapi, fresh) : "";
    const issuedFingerprint = displaySnappayFingerprint(
      snappayTokenFingerprint(String(result.response.paymentToken || "")),
    );
    const storedFingerprint = storedToken
      ? displaySnappayFingerprint(snappayTokenFingerprint(storedToken))
      : "";
    if (
      fresh &&
      storedToken &&
      storedFingerprint === issuedFingerprint &&
      String(fresh.attempt.redirectUrl || "")
    ) {
      return redirectedInitiation(
        fresh,
        String(fresh.attempt.redirectUrl),
        String(fresh.attempt.providerReference || transactionId),
      );
    }
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_TOKEN_OWNERSHIP_LOST",
      "The issued SnappPay token could not be installed on this generation",
      undefined,
      "reconcile",
    );
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }
  return redirectedInitiation(bundle, String(result.response.paymentPageUrl), transactionId);
}

async function observeExistingSnappayToken(
  strapi: Strapi,
  bundle: AttemptBundle,
  paymentToken: string,
  options: {
    allowRetarget: boolean;
    mobile?: string;
    callbackNonce: string;
    storedTrackId?: string;
  },
): Promise<InitiateSnappayResult> {
  const adapter = createSnappayAdapter(strapi);
  const statusResult = await adapter.status(paymentToken);
  const providerStatus = normalizeSnappayProviderStatus(statusResult.response?.status);
  const code = Number(statusResult.diagnostic.providerCode || 0);
  await updateProviderObservation(strapi, bundle, statusResult, providerStatus);

  if (isAmbiguousResult(statusResult)) {
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_STATUS_UNREADABLE",
      "SnappPay status is not readable; refusing a second token",
      undefined,
      "reconcile",
    );
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  if (statusResult.successful) {
    const identity = statusMatchesActiveSnappayGeneration(bundle.attempt, {
      transactionId: statusResult.response?.transactionId,
      amount: statusResult.response?.amount,
    });
    if (!identity.ok) {
      await markAttemptUnknown(
        strapi,
        bundle,
        identity.reason === "amount"
          ? "SNAPPAY_STATUS_AMOUNT_MISMATCH"
          : "SNAPPAY_STATUS_TX_MISMATCH",
        "SnappPay status does not match the active payment generation",
        undefined,
        "manual_review",
      );
      return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
    }
  }

  if (providerStatus === "SETTLE" || providerStatus === "VERIFY") {
    await enqueueImmediateReconciliation(strapi, bundle);
    return redirectedInitiation(
      bundle,
      paymentResultUrl(Number(bundle.order.id), "processing"),
      String(bundle.attempt.providerReference || ""),
    );
  }

  if (code === 1007 && hasValidatedOkCallback(bundle)) {
    await enqueueImmediateReconciliation(strapi, bundle);
    return redirectedInitiation(
      bundle,
      paymentResultUrl(Number(bundle.order.id), "processing"),
      String(bundle.attempt.providerReference || ""),
    );
  }

  if (code === 1048) {
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_VENTURE_MISMATCH",
      "SnappPay reported a merchant mismatch for this payment token",
      undefined,
      "manual_review",
    );
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  if (code === 1007 && Number(statusResult.diagnostic.httpStatus) === 404) {
    const resumeUrl = String(bundle.attempt.redirectUrl || "");
    const urlToken = extractSnappayPaymentTokenFromRedirectUrl(resumeUrl);
    const tokenFingerprint = paymentToken
      ? displaySnappayFingerprint(snappayTokenFingerprint(paymentToken))
      : "";
    const resume = snappayStoredPaymentPageResume({
      paymentToken,
      urlToken,
      storedTrackId: options.storedTrackId ?? "",
      redirectUrl: resumeUrl,
      orderStatus: bundle.order.Status,
      reservationStatus: bundle.order.ReservationStatus,
      attemptStatus: bundle.attempt.Status,
      attemptAmount: bundle.attempt.Amount,
      contractAmountToman: bundle.contract.Amount,
      quoteTotalToman: bundle.attempt.quoteSnapshot?.financialSummary?.total,
      providerReference: bundle.attempt.providerReference,
      providerResponse: bundle.attempt.providerResponse,
      tokenFingerprint,
      hasValidatedCallback: hasValidatedOkCallback(bundle) || hasFailedCallback(bundle),
    });
    if (resume.ok) {
      return resumeExistingPaymentPage(strapi, bundle, resumeUrl, {
        refreshReservation: false,
      });
    }
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_STATUS_NOT_FOUND",
      "SnappPay could not resolve this payment token; refusing a replacement token",
      undefined,
      "manual_review",
    );
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  if (code === 1007) {
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_STATUS_NOT_FOUND",
      "SnappPay could not resolve this payment token; refusing a replacement token",
      undefined,
      "manual_review",
    );
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  if (providerStatus === "PENDING") {
    if (hasValidatedOkCallback(bundle)) {
      await enqueueImmediateReconciliation(strapi, bundle);
      return redirectedInitiation(
        bundle,
        paymentResultUrl(Number(bundle.order.id), "processing"),
        String(bundle.attempt.providerReference || ""),
      );
    }
    const resumeUrl = String(bundle.attempt.redirectUrl || "");
    if (resumeUrl) {
      return resumeExistingPaymentPage(strapi, bundle, resumeUrl);
    }
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_PENDING_WITHOUT_REDIRECT",
      "SnappPay payment is pending without a resume URL",
      undefined,
      "reconcile",
    );
    await enqueueImmediateReconciliation(strapi, bundle);
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  if (providerStatus === "REGISTERED") {
    if (hasFailedCallback(bundle)) {
      await enqueueImmediateReconciliation(strapi, bundle);
      return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
    }
    const resumeUrl = String(bundle.attempt.redirectUrl || "");
    if (resumeUrl) {
      return resumeExistingPaymentPage(strapi, bundle, resumeUrl);
    }
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_REGISTERED_WITHOUT_REDIRECT",
      "SnappPay payment is registered without a resume URL",
      undefined,
      "reconcile",
    );
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  if (providerStatus === "REVERT" || providerStatus === "CANCEL") {
    if (!options.allowRetarget) {
      return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
    }
    return requestSnappayToken(strapi, bundle, {
      callbackNonce: options.callbackNonce,
      mobile: options.mobile,
      retarget: true,
    });
  }

  await markAttemptUnknown(
    strapi,
    bundle,
    "SNAPPAY_STATUS_UNREADABLE",
    "SnappPay status is not authoritative",
    undefined,
    "reconcile",
  );
  return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
}

export async function initiateSnappayPayment(
  strapi: Strapi,
  input: {
    paymentAttemptId: number;
    callbackNonce: string;
    mobile?: string;
  },
): Promise<InitiateSnappayResult> {
  if (!isSnappayHardenedInitiationEnabled()) {
    throw new Error("SNAPPAY_HARDENED_INITIATION_DISABLED");
  }
  assertSnappayRuntimeConfig();
  const bundle = await loadAttemptBundle(strapi, {
    id: input.paymentAttemptId,
    Gateway: "snappay",
  });
  if (!bundle) throw new Error("SNAPPAY_ATTEMPT_NOT_FOUND");
  const status = String(bundle.attempt.Status || "");
  if (status === "Succeeded") {
    return redirectedInitiation(bundle, paymentResultUrl(Number(bundle.order.id), "success"));
  }
  if (
    ["Failed", "Cancelled", "Expired"].includes(status) &&
    !snappayProviderPaymentIsUnresolved(bundle.attempt, bundle.transaction.TrackId)
  ) {
    return failedInitiation(bundle, "CHECKOUT_ATTEMPT_CONFLICT");
  }

  // Prefer observe/resume when a payment token already exists. That path must
  // not take the mint lease — a shopper who left SnappPay and taps پرداخت again
  // within 45s otherwise gets PAYMENT_IN_PROGRESS and never reaches GET /status.
  const storedTrackId = String(bundle.transaction.TrackId || "").trim();
  const paymentToken = await resolveSnappayPaymentToken(strapi, bundle);
  if (paymentToken) {
    return observeExistingSnappayToken(strapi, bundle, paymentToken, {
      allowRetarget: true,
      mobile: input.mobile,
      callbackNonce: input.callbackNonce,
      storedTrackId,
    });
  }

  if (snappayHasInFlightDispatch(bundle.attempt.providerResponse)) {
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  if (!matchesSnappayCallbackNonce(input.callbackNonce, bundle.attempt.callbackNonceHash)) {
    await markAttemptUnknown(
      strapi,
      bundle,
      "SNAPPAY_CALLBACK_NONCE_MISMATCH",
      "SnappPay callback correlation secret did not match",
      undefined,
      "manual_review",
    );
    return failedInitiation(bundle, "PAYMENT_UNKNOWN", "Unknown");
  }

  // First mint (and retarget after REVERT/CANCEL) claims the exclusive lease
  // inside requestSnappayToken so two tabs cannot open two BNPL plans.
  return requestSnappayToken(strapi, bundle, {
    callbackNonce: input.callbackNonce,
    mobile: input.mobile,
    retarget: false,
  });
}

async function createOrReuseOperation(
  strapi: Strapi,
  bundle: AttemptBundle,
  input: {
    type: OperationType;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
    delayMs?: number;
  },
): Promise<any> {
  let operation: any = await strapi.db.query(OPERATION_UID).findOne({
    where: { idempotencyKey: input.idempotencyKey },
  } as any);
  let shouldEnqueue = true;
  const nextRunAt = new Date(Date.now() + Math.max(0, input.delayMs || 0));
  if (operation) {
    if (
      operation.Status === "Succeeded" ||
      operation.Status === "Queued" ||
      operation.Status === "Processing" ||
      (operation.Status === "Unknown" && !operation.nextRunAt)
    ) {
      return operation;
    }
    operation = await strapi.db.query(OPERATION_UID).update({
      where: { id: operation.id },
      data: {
        Status: "Queued",
        nextRunAt,
        leaseUntil: null,
        metadata: {
          ...(operation.metadata || {}),
          ...(input.metadata || {}),
        },
      },
    } as any);
  } else {
    if (input.metadata?.operatorAction === true) {
      const result = await strapi.db.transaction(async ({ trx }) => {
        await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [
          bundle.attempt.id,
        ]);
        const operationQuery = strapi.db.query(OPERATION_UID);
        const replay: any = await operationQuery.findOne({
          where: { idempotencyKey: input.idempotencyKey },
          transacting: trx,
        } as any);
        if (replay) {
          if (
            replay.Status === "Succeeded" ||
            replay.Status === "Queued" ||
            replay.Status === "Processing" ||
            (replay.Status === "Unknown" && !replay.nextRunAt)
          ) {
            return { operation: replay, shouldEnqueue: false };
          }
          const requeued = await operationQuery.update({
            where: { id: replay.id },
            data: {
              Status: "Queued",
              nextRunAt,
              leaseUntil: null,
              metadata: {
                ...(replay.metadata || {}),
                ...(input.metadata || {}),
              },
            },
            transacting: trx,
          } as any);
          return { operation: requeued, shouldEnqueue: true };
        }
        const activeOperatorOperation: any = await operationQuery.findOne({
          where: {
            attemptKey: bundle.attempt.id,
            OperationType: { $in: ["CANCEL", "UPDATE"] },
            Status: { $in: ["Queued", "Processing", "Unknown"] },
          },
          transacting: trx,
        } as any);
        if (activeOperatorOperation) {
          throw new Error("SNAPPAY_OPERATOR_OPERATION_ACTIVE");
        }
        const created = await operationQuery.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            OperationType: input.type,
            Status: "Queued",
            retryCount: 0,
            nextRunAt,
            metadata: input.metadata || {},
            attemptKey: bundle.attempt.id,
            payment_attempt: bundle.attempt.id,
            order: bundle.order.id,
            contract_transaction: bundle.transaction.id,
          },
          transacting: trx,
        } as any);
        return { operation: created, shouldEnqueue: true };
      });
      operation = result.operation;
      shouldEnqueue = result.shouldEnqueue;
    } else {
      operation = await strapi.db.query(OPERATION_UID).create({
        data: {
          idempotencyKey: input.idempotencyKey,
          OperationType: input.type,
          Status: "Queued",
          retryCount: 0,
          nextRunAt,
          metadata: input.metadata || {},
          attemptKey: bundle.attempt.id,
          payment_attempt: bundle.attempt.id,
          order: bundle.order.id,
          contract_transaction: bundle.transaction.id,
        },
      } as any);
    }
  }
  if (!shouldEnqueue) return operation;
  if (input.metadata?.previousGeneration !== true) {
    await strapi.db.query(ATTEMPT_UID).update({
      where: { id: bundle.attempt.id },
      data: {
        Status: bundle.attempt.Status === "Redirected" ? "Pending" : bundle.attempt.Status,
        nextAction: input.type.toLowerCase(),
        nextActionAt: nextRunAt,
      },
    } as any);
  }
  try {
    await enqueueSnappayOperation(
      Number(operation.id),
      Number(operation.retryCount || 0),
      input.delayMs || 0,
    );
  } catch (error: any) {
    const operatorAction = input.metadata?.operatorAction === true;
    await Promise.all([
      strapi.db.query(OPERATION_UID).update({
        where: { id: operation.id },
        data: {
          Status: "Unknown",
          failureMessage: "Payment queue unavailable",
          nextRunAt: new Date(Date.now() + 60_000),
        },
      } as any),
      strapi.db.query(ATTEMPT_UID).update({
        where: { id: bundle.attempt.id },
        data: {
          Status: operatorAction ? bundle.attempt.Status : "Unknown",
          nextAction: operatorAction ? "operator_queue_recovery" : "queue_recovery",
          nextActionAt: new Date(Date.now() + 60_000),
        },
      } as any),
    ]);
    strapi.log.error("Failed to enqueue SnappPay operation", {
      operationId: operation.id,
      attemptId: bundle.attempt.id,
      error: String(error?.message || error).slice(0, 300),
    });
  }
  return operation;
}

async function resumeExistingReconcile(
  strapi: Strapi,
  bundle: AttemptBundle,
  existing: { id: unknown; Status?: unknown; retryCount?: unknown },
  metadata: Record<string, unknown>,
): Promise<void> {
  if (existing.Status === "Succeeded") return;
  const outcome = await requeueParkedSnappayReconcile(strapi, {
    operationId: Number(existing.id),
    attemptId: Number(bundle.attempt.id),
    metadata,
    nextRunAt: new Date(),
  });
  if (!shouldEnqueueSnappayReconcileResume(outcome)) return;
  if (outcome === "pulled_forward") {
    await enqueueSnappayOperation(Number(existing.id), Number(existing.retryCount || 0), 0, {
      jobIdSalt: "pull",
    });
    return;
  }
  await enqueueSnappayOperation(Number(existing.id), Number(existing.retryCount || 0), 0);
}

async function enqueueCallbackReconcile(
  strapi: Strapi,
  bundle: AttemptBundle,
  metadata: Record<string, unknown>,
): Promise<void> {
  const key = `reconcile:${bundle.attempt.id}`;
  const existing: any = await strapi.db.query(OPERATION_UID).findOne({
    where: { idempotencyKey: key },
  } as any);
  if (!existing) {
    await createOrReuseOperation(strapi, bundle, {
      type: "RECONCILE",
      idempotencyKey: key,
      metadata,
    });
    return;
  }
  await resumeExistingReconcile(strapi, bundle, existing, metadata);
}

export async function acceptSnappayCallback(
  strapi: Strapi,
  input: SnappayCallbackInput,
): Promise<{
  accepted: boolean;
  orderId?: number;
  redirectUrl: string;
  errorCode?: string;
}> {
  const transactionId = String(input.transactionId || "").trim();
  const nonce = String(input.nonce || "").trim();
  const state = String(input.state || "").toUpperCase();
  if (
    !isValidSnappayTransactionId(transactionId) ||
    !["OK", "FAILED"].includes(state) ||
    !Number.isInteger(input.amount) ||
    input.amount <= 0
  ) {
    return {
      accepted: false,
      redirectUrl: paymentResultUrl(undefined, "invalid_callback"),
      errorCode: "SNAPPAY_CALLBACK_INVALID",
    };
  }
  const bundle = await findAttemptByTransactionId(strapi, transactionId);
  const nonceMatches = Boolean(
    bundle &&
      isValidSnappayCallbackNonce(nonce) &&
      rememberedSnappayNonceHashes(bundle.attempt).some((hash) =>
        matchesSnappayCallbackNonce(nonce, hash),
      ),
  );
  const expectedAmount = bundle ? gatewayExpectedAmountIrr(bundle.attempt) : 0;
  if (!bundle || !nonceMatches || expectedAmount !== Number(input.amount)) {
    strapi.log.warn("Rejected uncorrelated SnappPay callback", {
      transactionId,
      state,
      amountMatches: !!bundle && expectedAmount === Number(input.amount),
    });
    return {
      accepted: false,
      redirectUrl: paymentResultUrl(undefined, "invalid_callback"),
      errorCode: "SNAPPAY_CALLBACK_MISMATCH",
    };
  }
  const orderId = Number(bundle.order.id);
  const establishedSuccess =
    String(bundle.attempt.Status) === "Succeeded" ||
    ["SETTLE", "VERIFY"].includes(String(bundle.attempt.providerStatus || ""));
  if (establishedSuccess) {
    return {
      accepted: true,
      orderId,
      redirectUrl: paymentResultUrl(orderId, "recorded"),
    };
  }
  const locallyTerminal = ["Succeeded", "Cancelled", "Failed", "Expired"].includes(
    String(bundle.attempt.Status),
  );
  if (
    locallyTerminal &&
    !snappayProviderPaymentIsUnresolved(bundle.attempt, bundle.transaction.TrackId)
  ) {
    return {
      accepted: true,
      orderId,
      redirectUrl: paymentResultUrl(orderId, "recorded"),
    };
  }
  if (
    state === "FAILED" &&
    (String(bundle.attempt.providerStatus || "") === "CALLBACK_OK" ||
      String(bundle.attempt.nextAction || "") === "verify")
  ) {
    strapi.log.warn("Ignored failed SnappPay callback over established success evidence", {
      attemptId: bundle.attempt.attemptId,
      orderId,
    });
    return {
      accepted: true,
      orderId,
      redirectUrl: paymentResultUrl(orderId, "processing"),
    };
  }

  const generationState = readSnappayGenerationState(bundle.attempt.providerResponse);
  if (snappayCallbackTargetsPreviousGeneration(bundle.attempt, transactionId)) {
    const previous = generationState.previousGeneration;
    const previousNonce = previous?.callbackNonceHash;
    if (!previousNonce || !matchesSnappayCallbackNonce(nonce, previousNonce)) {
      return {
        accepted: false,
        redirectUrl: paymentResultUrl(undefined, "invalid_callback"),
        errorCode: "SNAPPAY_CALLBACK_MISMATCH",
      };
    }
    await mergePreviousGenerationCallback(strapi, {
      attemptId: Number(bundle.attempt.id),
      previousTransactionId: transactionId,
      patch: {
        callbackState: state,
        callbackReceivedAt: new Date().toISOString(),
      },
    });
    await createOrReuseOperation(strapi, bundle, {
      type: "RECONCILE",
      idempotencyKey: `reconcile:${bundle.attempt.id}:previous:${previous?.seq || 0}`,
      metadata: {
        callbackState: state,
        callbackReceivedAt: new Date().toISOString(),
        transactionId,
        generationSeq: previous?.seq,
        previousGeneration: true,
      },
    });
    return {
      accepted: true,
      orderId,
      redirectUrl: paymentResultUrl(orderId, "processing"),
    };
  }

  const currentNonceHashes = [
    String(bundle.attempt.callbackNonceHash || ""),
    String(generationState.generation?.callbackNonceHash || ""),
    String(generationState.pendingDispatch?.callbackNonceHash || ""),
  ].filter(Boolean);
  const currentNonceMatches = currentNonceHashes.some((hash) =>
    matchesSnappayCallbackNonce(nonce, hash),
  );
  if (!currentNonceMatches) {
    return {
      accepted: false,
      redirectUrl: paymentResultUrl(undefined, "invalid_callback"),
      errorCode: "SNAPPAY_CALLBACK_MISMATCH",
    };
  }

  await strapi.db.query(ATTEMPT_UID).update({
    where: { id: bundle.attempt.id, Status: { $ne: "Succeeded" } },
    data: {
      Status: "Pending",
      providerStatus: `CALLBACK_${state}`,
      nextAction: state === "OK" ? "verify" : "reconcile_failed_callback",
      nextActionAt: new Date(),
      failureCode: null,
      failureMessage: null,
    },
  } as any);
  bundle.attempt.Status = "Pending";
  bundle.attempt.providerStatus = `CALLBACK_${state}`;
  bundle.attempt.nextAction = state === "OK" ? "verify" : "reconcile_failed_callback";
  await enqueueCallbackReconcile(strapi, bundle, {
    callbackState: state,
    callbackReceivedAt: new Date().toISOString(),
    transactionId,
    generationSeq: generationState.generation?.seq || generationState.tokenAttemptSeq || 1,
  });
  return {
    accepted: true,
    orderId,
    redirectUrl: paymentResultUrl(orderId, "processing"),
  };
}

export async function requestSnappayReconciliation(
  strapi: Strapi,
  orderId: number,
  reason = "manual",
): Promise<any | null> {
  // An order the customer retried has several SnappPay attempts. Without an
  // explicit order this picked an arbitrary one, so a retry could reconcile a
  // dead attempt and its dead token while the live one sat untouched.
  const bundle = await loadAttemptBundle(
    strapi,
    { Gateway: "snappay", order: { id: orderId } },
    { orderBy: { createdAt: "desc" } },
  );
  if (!bundle) return null;
  if (["Succeeded", "Cancelled", "Failed", "Expired"].includes(String(bundle.attempt.Status))) {
    return bundle.attempt;
  }
  const key = `reconcile:${bundle.attempt.id}`;
  const existing: any = await strapi.db.query(OPERATION_UID).findOne({
    where: { idempotencyKey: key },
  } as any);
  const metadata = { requestedReason: String(reason).slice(0, 100) };
  if (!existing) {
    await createOrReuseOperation(strapi, bundle, {
      type: "RECONCILE",
      idempotencyKey: key,
      metadata,
    });
    return bundle.attempt;
  }
  await resumeExistingReconcile(strapi, bundle, existing, metadata);
  return bundle.attempt;
}

const stableDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

function assertOperatorReason(reason: unknown): string {
  const value = String(reason || "").trim();
  if (value.length < 3 || value.length > 500) {
    throw new Error("SNAPPAY_OPERATOR_REASON_REQUIRED");
  }
  return value;
}

/**
 * True when automatic recovery has given up on this attempt and parked it for a
 * human. `markManualReview` is the only writer of this state.
 *
 * Such an attempt has `nextActionAt: null`, so nothing will ever re-queue it —
 * an operator is the only way forward. Both the operator guard below and the
 * reservation-expiry job key off this so a parked attempt does not become a
 * permanent inventory leak.
 */
export function isSnappayAttemptParkedForReview(attempt: any): boolean {
  return String(attempt?.nextAction || "") === "manual_review";
}

function assertOperatorBundle(
  bundle: AttemptBundle,
  options: {
    allowParkedForReview?: boolean;
    /** Cancel may run after auto-shipment; update/adjust stay pre-fulfilment. */
    allowFulfilledOrderStatuses?: boolean;
  } = {},
): void {
  // Item update still requires the barcode to be voided first. Cancel clears the
  // local barcode when the provider confirms, so a barcode must not block it.
  if (!options.allowFulfilledOrderStatuses && bundle.order.ShippingBarcode) {
    throw new Error("SNAPPAY_OPERATOR_STATE_INVALID");
  }

  const orderStatus = String(bundle.order.Status || "");
  const allowedOrderStatuses = options.allowFulfilledOrderStatuses
    ? ["Started", "Done", "Shipment"]
    : ["Started"];
  const settled =
    bundle.attempt.Status === "Succeeded" &&
    bundle.attempt.providerStatus === "SETTLE" &&
    allowedOrderStatuses.includes(orderStatus);
  if (settled) return;

  // Recovery path: automatic reconciliation exhausted itself and parked the
  // attempt. Without this the operator got a 409 on both Cancel and Adjust, so a
  // parked order held its stock reservation forever with no remedy in the UI.
  if (options.allowParkedForReview && isSnappayAttemptParkedForReview(bundle.attempt)) {
    return;
  }

  throw new Error("SNAPPAY_OPERATOR_STATE_INVALID");
}

export async function queueSnappayAdminCancel(
  strapi: Strapi,
  input: {
    orderId: number;
    reason: string;
    actorId: number;
    requestKey?: string;
  },
) {
  const bundle = await loadAttemptBundle(strapi, {
    Gateway: "snappay",
    order: { id: input.orderId },
  });
  if (!bundle) throw new Error("SNAPPAY_ATTEMPT_NOT_FOUND");
  // Cancel is the operator's recovery tool, so it must also work on an attempt
  // that automatic reconciliation parked for manual review, and on orders that
  // have already been marked Done / Shipment (often with a local Anipo barcode).
  assertOperatorBundle(bundle, {
    allowParkedForReview: true,
    allowFulfilledOrderStatuses: true,
  });
  const reason = assertOperatorReason(input.reason);
  const digest = stableDigest({
    orderId: input.orderId,
    actorId: input.actorId,
    reason,
    requestKey: String(input.requestKey || ""),
  });
  return createOrReuseOperation(strapi, bundle, {
    type: "CANCEL",
    idempotencyKey: `cancel:${bundle.attempt.id}:${digest}`,
    metadata: {
      operatorAction: true,
      reason,
      actorId: Number(input.actorId),
      requestedAt: new Date().toISOString(),
    },
  });
}

export async function queueSnappayAdminUpdate(
  strapi: Strapi,
  input: {
    orderId: number;
    reason: string;
    actorId: number;
    changes: Array<{
      orderItemId: number;
      oldCount: number;
      newCount: number;
      restockDelta: number;
    }>;
    newTotalToman: number;
    newDiscountToman: number;
    newShippingToman: number;
    expectedOldTotalToman: number;
    requestKey?: string;
  },
) {
  const bundle = await loadAttemptBundle(strapi, {
    Gateway: "snappay",
    order: { id: input.orderId },
  });
  if (!bundle) throw new Error("SNAPPAY_ATTEMPT_NOT_FOUND");
  assertOperatorBundle(bundle);
  const reason = assertOperatorReason(input.reason);
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new Error("SNAPPAY_OPERATOR_CHANGES_REQUIRED");
  }
  const metadata = {
    operatorAction: true,
    reason,
    actorId: Number(input.actorId),
    changes: input.changes,
    newTotalToman: Number(input.newTotalToman),
    newDiscountToman: Number(input.newDiscountToman),
    newShippingToman: Number(input.newShippingToman),
    expectedOldTotalToman: Number(input.expectedOldTotalToman),
    requestedAt: new Date().toISOString(),
  };
  const digest = stableDigest({
    orderId: input.orderId,
    actorId: input.actorId,
    reason,
    changes: input.changes,
    newTotalToman: input.newTotalToman,
    newDiscountToman: input.newDiscountToman,
    newShippingToman: input.newShippingToman,
    expectedOldTotalToman: input.expectedOldTotalToman,
    requestKey: String(input.requestKey || ""),
  });
  return createOrReuseOperation(strapi, bundle, {
    type: "UPDATE",
    idempotencyKey: `update:${bundle.attempt.id}:${digest}`,
    metadata,
  });
}

export async function claimSnappayOperation(strapi: Strapi, operationId: number) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + OPERATION_LEASE_MS);
  const result = await strapi.db.connection.raw(
    `UPDATE payment_operations
     SET status = 'Processing',
         lease_until = ?,
         updated_at = ?
     WHERE id = ?
       AND (
         (status = 'Queued' AND (next_run_at IS NULL OR next_run_at <= ?))
         OR (status = 'Unknown' AND next_run_at IS NOT NULL AND next_run_at <= ?)
         OR (status = 'Processing' AND lease_until < ?)
       )
     RETURNING id`,
    [leaseUntil, now, operationId, now, now, now],
  );
  return (result?.rows || []).length === 1;
}

async function loadOperationBundle(
  strapi: Strapi,
  operationId: number,
): Promise<{ operation: any; bundle: AttemptBundle } | null> {
  const operation: any = await strapi.db.query(OPERATION_UID).findOne({
    where: { id: operationId },
    populate: {
      payment_attempt: true,
      order: true,
      contract_transaction: true,
    },
  } as any);
  if (!operation?.payment_attempt?.id) return null;
  const bundle = await loadAttemptBundle(strapi, {
    id: Number(operation.payment_attempt.id),
  });
  return bundle ? { operation, bundle } : null;
}

async function markOperationSucceeded(
  strapi: Strapi,
  operationId: number,
  providerStatus?: string,
  observation?: OperationObservation,
) {
  await strapi.db.query(OPERATION_UID).update({
    where: { id: operationId },
    data: {
      Status: "Succeeded",
      providerStatus,
      ...(Number.isInteger(observation?.httpStatus) ? { httpStatus: observation?.httpStatus } : {}),
      ...(Number.isInteger(observation?.providerCode)
        ? { providerCode: observation?.providerCode }
        : {}),
      leaseUntil: null,
      nextRunAt: null,
      failureMessage: null,
    },
  } as any);
}

/**
 * Writes attempt state from a failure path, but never over a settled attempt.
 *
 * `finalizeAndComplete` mutates `bundle.attempt.Status` in memory *after* the
 * settlement transaction commits, so a later failure handler cannot tell from the
 * bundle whether money has already been captured. Anything after that commit can
 * still throw, and the resulting retry / manual-review write used to stamp
 * `Status: "Unknown"` over a paid, stock-consumed, `Started` order. That defeated
 * the replay guard in `finalizeSnappaySettlement` and locked operators out via
 * `assertOperatorBundle`.
 *
 * The `$ne` predicate makes the guard a property of the UPDATE itself, so it also
 * holds against a concurrent writer rather than relying on a read-then-write.
 */
async function updateAttemptUnlessSettled(
  strapi: Strapi,
  bundle: AttemptBundle,
  data: Record<string, unknown>,
): Promise<void> {
  const updated = await strapi.db.query(ATTEMPT_UID).update({
    where: { id: bundle.attempt.id, Status: { $ne: "Succeeded" } },
    data,
  } as any);
  if (!updated) {
    strapi.log.warn("Refused to downgrade a settled SnappPay attempt from a failure path", {
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order.id,
      attemptedStatus: data.Status,
    });
  }
}

async function markManualReview(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  code: string,
  message: string,
) {
  await Promise.all([
    strapi.db.query(OPERATION_UID).update({
      where: { id: operation.id },
      data: {
        Status: "Unknown",
        leaseUntil: null,
        nextRunAt: null,
        failureMessage: message.slice(0, 500),
      },
    } as any),
    updateAttemptUnlessSettled(strapi, bundle, {
      Status: "Unknown",
      nextAction: "manual_review",
      nextActionAt: null,
      failureCode: code,
      failureMessage: message.slice(0, 500),
      lastReconciledAt: new Date(),
    }),
  ]);
  strapi.log.error("SnappPay operation requires manual review", {
    operationId: operation.id,
    attemptId: bundle.attempt.attemptId,
    orderId: bundle.order.id,
    transactionId: bundle.attempt.providerReference,
    code,
  });
}

async function markOperatorOperation(
  strapi: Strapi,
  operationId: number,
  status: "Failed" | "Unknown",
  code: string,
  message: string,
  observation?: OperationObservation,
) {
  await strapi.db.query(OPERATION_UID).update({
    where: { id: operationId },
    data: {
      Status: status,
      ...(observation?.providerStatus ? { providerStatus: observation.providerStatus } : {}),
      ...(Number.isInteger(observation?.httpStatus) ? { httpStatus: observation?.httpStatus } : {}),
      ...(Number.isInteger(observation?.providerCode)
        ? { providerCode: observation?.providerCode }
        : {}),
      leaseUntil: null,
      nextRunAt: null,
      failureMessage: `${code}:${message}`.slice(0, 500),
    },
  } as any);
}

async function scheduleOperatorRetry(
  strapi: Strapi,
  operation: any,
  delayMs: number,
  reason: string,
  observation?: OperationObservation,
) {
  const retryCount = Number(operation.retryCount || 0) + 1;
  const nextRunAt = new Date(Date.now() + delayMs);
  await strapi.db.query(OPERATION_UID).update({
    where: { id: operation.id },
    data: {
      Status: "Queued",
      retryCount,
      nextRunAt,
      ...(observation?.providerStatus ? { providerStatus: observation.providerStatus } : {}),
      ...(Number.isInteger(observation?.httpStatus) ? { httpStatus: observation?.httpStatus } : {}),
      ...(Number.isInteger(observation?.providerCode)
        ? { providerCode: observation?.providerCode }
        : {}),
      leaseUntil: null,
      failureMessage: reason.slice(0, 500),
    },
  } as any);
  await enqueueSnappayOperation(Number(operation.id), retryCount, delayMs).catch((error: any) => {
    strapi.log.error("Failed to enqueue SnappPay operator retry", {
      operationId: operation.id,
      retryCount,
      error: String(error?.message || error).slice(0, 300),
    });
  });
}

async function markActionManualReview(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  code: string,
  message: string,
  observation?: OperationObservation,
) {
  if (operation.metadata?.operatorAction === true) {
    return markOperatorOperation(strapi, operation.id, "Unknown", code, message, observation);
  }
  return markManualReview(strapi, operation, bundle, code, message);
}

export function isSnappayReconciliationExhausted(retryCount: unknown): boolean {
  const parsed = Number(retryCount);
  return (
    Number.isFinite(parsed) &&
    Math.max(0, Math.trunc(parsed)) >= SNAPPAY_RECONCILIATION_DELAYS_MS.length
  );
}

async function scheduleOperationRetry(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  delayMs: number,
  reason: string,
) {
  if (isSnappayReconciliationExhausted(operation.retryCount)) {
    return markManualReview(
      strapi,
      operation,
      bundle,
      "SNAPPAY_RECONCILIATION_EXHAUSTED",
      `Automatic reconciliation exhausted: ${reason}`.slice(0, 500),
    );
  }
  const retryCount = Number(operation.retryCount || 0) + 1;
  const nextRunAt = new Date(Date.now() + delayMs);
  await Promise.all([
    strapi.db.query(OPERATION_UID).update({
      where: { id: operation.id },
      data: {
        Status: "Queued",
        retryCount,
        nextRunAt,
        leaseUntil: null,
        failureMessage: reason.slice(0, 500),
      },
    } as any),
    updateAttemptUnlessSettled(strapi, bundle, {
      Status: "Unknown",
      nextAction: "reconcile",
      nextActionAt: nextRunAt,
      failureCode: "SNAPPAY_RECONCILIATION_PENDING",
      failureMessage: reason.slice(0, 500),
    }),
  ]);
  await enqueueSnappayOperation(Number(operation.id), retryCount, delayMs).catch((error: any) => {
    strapi.log.error("Failed to enqueue delayed SnappPay retry", {
      operationId: operation.id,
      retryCount,
      error: String(error?.message || error).slice(0, 300),
    });
  });
}

function reconciliationDelay(retryCount: number): number {
  const index = Math.min(Math.max(0, retryCount), SNAPPAY_RECONCILIATION_DELAYS_MS.length - 1);
  return SNAPPAY_RECONCILIATION_DELAYS_MS[index];
}

function idsFrom(bundle: AttemptBundle) {
  return {
    attemptId: Number(bundle.attempt.id),
    orderId: Number(bundle.order.id),
    contractId: Number(bundle.contract.id),
    transactionRowId: Number(bundle.transaction.id),
    transactionId: String(bundle.attempt.providerReference),
  };
}

async function queueSideEffects(strapi: Strapi, bundle: AttemptBundle) {
  await createOrReuseOperation(strapi, bundle, {
    type: "FINALIZE_EFFECTS",
    idempotencyKey: `effects:${bundle.attempt.id}`,
  });
}

async function finalizeAndComplete(strapi: Strapi, operation: any, bundle: AttemptBundle) {
  await finalizeSnappaySettlement(strapi, idsFrom(bundle));
  bundle.attempt.Status = "Succeeded";
  await markOperationSucceeded(strapi, operation.id, "SETTLE");
  // Money is captured and the order is Started at this point. Side effects
  // (cart clear, analytics delivery, activity log) are cosmetic by comparison and
  // must never turn a completed settlement into a retry or a manual review.
  // `sweepSnappaySideEffects` re-queues anything missed here, so swallowing is
  // safe rather than lossy — including when the process dies mid-way.
  try {
    await queueSideEffects(strapi, bundle);
  } catch (error: any) {
    strapi.log.error("Failed to queue SnappPay side effects after settlement", {
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order.id,
      error: String(error?.message || error).slice(0, 300),
    });
  }
}

async function cancelLocallyAndComplete(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  providerStatus: "REVERT" | "CANCEL",
  reason: string,
) {
  await applySnappayCancellation(strapi, idsFrom(bundle), providerStatus, reason);
  bundle.attempt.Status = "Cancelled";
  await markOperationSucceeded(strapi, operation.id, providerStatus);
}

async function performCancel(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  token: string,
  reason: string,
) {
  const adapter = createSnappayAdapter(strapi);
  const cancelResult = await adapter.cancel(token);
  if (cancelResult.successful) {
    await updateProviderObservation(strapi, bundle, cancelResult, "CANCEL");
    return cancelLocallyAndComplete(strapi, operation, bundle, "CANCEL", reason);
  }
  const statusResult = await adapter.status(token);
  const status = normalizeSnappayProviderStatus(statusResult.response?.status);
  await updateProviderObservation(strapi, bundle, statusResult, status);
  if (status === "CANCEL") {
    return cancelLocallyAndComplete(strapi, operation, bundle, "CANCEL", reason);
  }
  if (status === "REVERT") {
    return cancelLocallyAndComplete(strapi, operation, bundle, "REVERT", reason);
  }
  if (status === "VERIFY") {
    return performSettle(strapi, operation, bundle, token, true);
  }
  const code = cancelResult.diagnostic.providerCode || statusResult.diagnostic.providerCode;
  if (code === 1053 && Number(operation.retryCount || 0) < 1) {
    return operation.metadata?.operatorAction === true
      ? scheduleOperatorRetry(
          strapi,
          operation,
          5_000,
          "SnappPay cancellation is already in progress",
          operationObservation(cancelResult, status),
        )
      : scheduleOperationRetry(
          strapi,
          operation,
          bundle,
          5_000,
          "SnappPay cancellation is already in progress",
        );
  }
  return markActionManualReview(
    strapi,
    operation,
    bundle,
    code === 1007 || code === 1048 ? `SNAPPAY_CANCEL_${code}` : "SNAPPAY_CANCEL_AMBIGUOUS",
    "SnappPay cancel result requires manual review",
    operationObservation(cancelResult, status),
  );
}

async function performSettle(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  token: string,
  cancelAfterSettlement: boolean,
) {
  const adapter = createSnappayAdapter(strapi);
  const settleResult = await adapter.settle(token);
  if (settleResult.successful) {
    await updateProviderObservation(strapi, bundle, settleResult, "SETTLE");
    if (cancelAfterSettlement) {
      return performCancel(strapi, operation, bundle, token, "failed_callback_after_verify");
    }
    return finalizeAndComplete(strapi, operation, bundle);
  }

  const statusResult = await adapter.status(token);
  const status = normalizeSnappayProviderStatus(statusResult.response?.status);
  await updateProviderObservation(strapi, bundle, statusResult, status);
  if (status === "SETTLE") {
    if (cancelAfterSettlement) {
      return performCancel(strapi, operation, bundle, token, "failed_callback_after_settlement");
    }
    return finalizeAndComplete(strapi, operation, bundle);
  }
  if (status === "VERIFY" && Number(operation.retryCount || 0) < 1) {
    return operation.metadata?.operatorAction === true
      ? scheduleOperatorRetry(
          strapi,
          operation,
          5_000,
          "SnappPay settle remains in VERIFY",
          operationObservation(settleResult, status),
        )
      : scheduleOperationRetry(
          strapi,
          operation,
          bundle,
          5_000,
          "SnappPay settle remains in VERIFY",
        );
  }
  const code = settleResult.diagnostic.providerCode || statusResult.diagnostic.providerCode;
  if (code === 1007 || code === 1048) {
    return markActionManualReview(
      strapi,
      operation,
      bundle,
      `SNAPPAY_SETTLE_${code}`,
      "SnappPay settlement cannot be reconciled automatically",
      operationObservation(settleResult, status),
    );
  }
  if (operation.metadata?.operatorAction === true) {
    return markOperatorOperation(
      strapi,
      operation.id,
      "Unknown",
      "SNAPPAY_SETTLE_AMBIGUOUS",
      "Settlement before cancellation requires manual review",
      operationObservation(settleResult, status),
    );
  }
  return scheduleOperationRetry(
    strapi,
    operation,
    bundle,
    reconciliationDelay(Number(operation.retryCount || 0)),
    "SnappPay settlement is not yet authoritative",
  );
}

async function performVerify(strapi: Strapi, operation: any, bundle: AttemptBundle, token: string) {
  const adapter = createSnappayAdapter(strapi);
  const verifyResult = await adapter.verify(token);
  if (verifyResult.successful) {
    await strapi.db.query(TX_UID).update({
      where: { id: bundle.transaction.id },
      data: {
        GatewayStatus: "VERIFY",
        VerifiedAt: new Date(),
        LastHttpStatus: verifyResult.diagnostic.httpStatus,
        LastProviderCode: verifyResult.diagnostic.providerCode,
        GatewayResponse: providerSummary(verifyResult),
      },
    } as any);
    bundle.transaction.GatewayStatus = "VERIFY";
    return performSettle(strapi, operation, bundle, token, false);
  }

  const statusResult = await adapter.status(token);
  const status = normalizeSnappayProviderStatus(statusResult.response?.status);
  await updateProviderObservation(strapi, bundle, statusResult, status);
  if (status === "VERIFY") {
    return performSettle(strapi, operation, bundle, token, false);
  }
  if (status === "SETTLE") {
    return finalizeAndComplete(strapi, operation, bundle);
  }
  if (status === "PENDING" && Number(operation.retryCount || 0) < 1) {
    return scheduleOperationRetry(
      strapi,
      operation,
      bundle,
      30_000,
      "SnappPay verification remains pending",
    );
  }
  if (status === "REVERT" || status === "CANCEL") {
    return cancelLocallyAndComplete(
      strapi,
      operation,
      bundle,
      status,
      "provider_status_after_verify",
    );
  }
  const code = verifyResult.diagnostic.providerCode || statusResult.diagnostic.providerCode;
  if (code === 1007 || code === 1048) {
    return markActionManualReview(
      strapi,
      operation,
      bundle,
      code === 1048 ? "SNAPPAY_VENTURE_MISMATCH" : "SNAPPAY_STATUS_NOT_FOUND",
      "SnappPay verification could not resolve this payment token",
      operationObservation(verifyResult, status),
    );
  }
  return scheduleOperationRetry(
    strapi,
    operation,
    bundle,
    reconciliationDelay(Number(operation.retryCount || 0)),
    "SnappPay verification is ambiguous",
  );
}

async function performRevert(strapi: Strapi, operation: any, bundle: AttemptBundle, token: string) {
  const adapter = createSnappayAdapter(strapi);
  const revertResult = await adapter.revert(token);
  if (revertResult.successful) {
    await updateProviderObservation(strapi, bundle, revertResult, "REVERT");
    return cancelLocallyAndComplete(strapi, operation, bundle, "REVERT", "failed_callback");
  }
  const statusResult = await adapter.status(token);
  const status = normalizeSnappayProviderStatus(statusResult.response?.status);
  await updateProviderObservation(strapi, bundle, statusResult, status);
  if (status === "REVERT" || status === "CANCEL") {
    return cancelLocallyAndComplete(
      strapi,
      operation,
      bundle,
      status,
      "provider_status_after_revert",
    );
  }
  if (status === "SETTLE") {
    return performCancel(strapi, operation, bundle, token, "failed_callback_already_settled");
  }
  if (status === "VERIFY") {
    return performSettle(strapi, operation, bundle, token, true);
  }
  const revertCode = Number(
    revertResult.diagnostic.providerCode || statusResult.diagnostic.providerCode || 0,
  );
  if (status === "REGISTERED" || revertCode === 1011) {
    return scheduleOperationRetry(
      strapi,
      operation,
      bundle,
      30 * 60 * 1000,
      "SnappPay revert is still registered; waiting 30 minutes before retrying",
    );
  }
  if (Number(operation.retryCount || 0) < 1) {
    return scheduleOperationRetry(strapi, operation, bundle, 5_000, "SnappPay revert is ambiguous");
  }
  return markManualReview(
    strapi,
    operation,
    bundle,
    "SNAPPAY_REVERT_AMBIGUOUS",
    "SnappPay revert requires manual review",
  );
}

async function performOperatorUpdate(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  token: string,
) {
  const payload = await buildAdminUpdatePayload(strapi, bundle, token, operation.metadata);
  const adapter = createSnappayAdapter(strapi);
  const result = await adapter.update(payload);
  if (result.successful) {
    try {
      await applySnappayAdminUpdate(strapi, idsFrom(bundle), {
        changes: operation.metadata.changes,
        newTotalToman: Number(operation.metadata.newTotalToman),
        newDiscountToman: Number(operation.metadata.newDiscountToman),
        newShippingToman: Number(operation.metadata.newShippingToman),
        expectedOldTotalToman: Number(operation.metadata.expectedOldTotalToman),
        reason: String(operation.metadata.reason),
        actorId: Number(operation.metadata.actorId),
        operationId: Number(operation.id),
      });
    } catch (error: any) {
      await markOperatorOperation(
        strapi,
        operation.id,
        "Unknown",
        "SNAPPAY_UPDATE_LOCAL_COMMIT_FAILED",
        String(error?.message || error),
        operationObservation(result, "SETTLE"),
      );
      return;
    }
    await markOperationSucceeded(
      strapi,
      operation.id,
      "SETTLE",
      operationObservation(result, "SETTLE"),
    );
    return;
  }
  const code = Number(result.diagnostic.providerCode || 0);
  if (code === 1053 && Number(operation.retryCount || 0) < 1) {
    return scheduleOperatorRetry(
      strapi,
      operation,
      5_000,
      "SnappPay update request is already in progress",
      operationObservation(result, bundle.attempt.providerStatus),
    );
  }
  if (code === 1011) {
    const statusResult = await adapter.status(token);
    const status = normalizeSnappayProviderStatus(statusResult.response?.status);
    await updateProviderObservation(strapi, bundle, statusResult, status);
    if (!statusResult.successful) {
      return markOperatorOperation(
        strapi,
        operation.id,
        "Unknown",
        "SNAPPAY_UPDATE_STATUS_AMBIGUOUS",
        "Provider status could not be confirmed after update rejection",
        operationObservation(result, status),
      );
    }
    if (status === "CANCEL" || status === "REVERT") {
      await applySnappayCancellation(
        strapi,
        idsFrom(bundle),
        status,
        "provider_cancelled_during_operator_update",
      );
      return markOperatorOperation(
        strapi,
        operation.id,
        "Failed",
        "SNAPPAY_UPDATE_ORDER_CANCELLED",
        "The provider order is already cancelled",
        operationObservation(result, status),
      );
    }
    if (status === "VERIFY" && Number(operation.retryCount || 0) < 1) {
      const settleResult = await adapter.settle(token);
      if (settleResult.successful) {
        await updateProviderObservation(strapi, bundle, settleResult, "SETTLE");
        return scheduleOperatorRetry(
          strapi,
          operation,
          5_000,
          "SnappPay order was settled before retrying update",
          operationObservation(result, "SETTLE"),
        );
      }
      const settledStatusResult = await adapter.status(token);
      const settledStatus = normalizeSnappayProviderStatus(settledStatusResult.response?.status);
      await updateProviderObservation(strapi, bundle, settledStatusResult, settledStatus);
      if (settledStatus === "SETTLE") {
        return scheduleOperatorRetry(
          strapi,
          operation,
          5_000,
          "SnappPay settlement confirmed before retrying update",
          operationObservation(result, settledStatus),
        );
      }
      return markOperatorOperation(
        strapi,
        operation.id,
        "Unknown",
        "SNAPPAY_UPDATE_SETTLE_AMBIGUOUS",
        "Settlement before update requires manual review",
        operationObservation(settleResult, settledStatus),
      );
    }
    if (status === "SETTLE" && Number(operation.retryCount || 0) < 1) {
      return scheduleOperatorRetry(
        strapi,
        operation,
        5_000,
        "SnappPay settlement confirmed before retrying update",
        operationObservation(result, status),
      );
    }
    return markOperatorOperation(
      strapi,
      operation.id,
      "Failed",
      "SNAPPAY_UPDATE_1011",
      `SnappPay rejected update in provider state ${status}`,
      operationObservation(result, status),
    );
  }
  if (code === 1036 || code === 1042 || code === 1078) {
    return markOperatorOperation(
      strapi,
      operation.id,
      "Failed",
      `SNAPPAY_UPDATE_${code}`,
      result.errorData?.message || "SnappPay rejected the update",
      operationObservation(result, bundle.attempt.providerStatus),
    );
  }
  return markOperatorOperation(
    strapi,
    operation.id,
    "Unknown",
    "SNAPPAY_UPDATE_AMBIGUOUS",
    "SnappPay update result requires manual review",
    operationObservation(result, bundle.attempt.providerStatus),
  );
}

async function executeRecoveryAction(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  token: string,
  action: SnappayRecoveryAction,
) {
  switch (action) {
    case "VERIFY":
      return performVerify(strapi, operation, bundle, token);
    case "SETTLE":
      return performSettle(strapi, operation, bundle, token, false);
    case "SETTLE_THEN_CANCEL":
      return performSettle(strapi, operation, bundle, token, true);
    case "REVERT":
      return performRevert(strapi, operation, bundle, token);
    case "FINALIZE_LOCAL":
      return finalizeAndComplete(strapi, operation, bundle);
    case "CANCEL_LOCAL": {
      const fresh = await loadAttemptBundle(strapi, { id: bundle.attempt.id });
      if (fresh) {
        if (
          ["Succeeded", "Cancelled", "Failed", "Expired"].includes(String(fresh.attempt.Status))
        ) {
          await markOperationSucceeded(strapi, operation.id, fresh.attempt.providerStatus);
          return;
        }
        const freshToken = await resolveSnappayPaymentToken(strapi, fresh);
        if (freshToken && freshToken !== token) {
          await markOperationSucceeded(strapi, operation.id, fresh.attempt.providerStatus);
          return;
        }
      }
      const status = normalizeSnappayProviderStatus(
        bundle.transaction.GatewayStatus || bundle.attempt.providerStatus,
      );
      return cancelLocallyAndComplete(
        strapi,
        operation,
        bundle,
        status === "CANCEL" ? "CANCEL" : "REVERT",
        "provider_terminal_status",
      );
    }
    case "FAIL_CONFIGURATION":
      return markManualReview(
        strapi,
        operation,
        bundle,
        "SNAPPAY_CONFIGURATION_FAILURE",
        "SnappPay configuration requires operator attention",
      );
    case "MANUAL_REVIEW":
      return markManualReview(
        strapi,
        operation,
        bundle,
        "SNAPPAY_MANUAL_REVIEW",
        "SnappPay provider state requires manual review",
      );
    case "RECONCILE":
      return scheduleOperationRetry(
        strapi,
        operation,
        bundle,
        reconciliationDelay(Number(operation.retryCount || 0)),
        "SnappPay status is not yet authoritative",
      );
  }
}

export async function processSnappayOperation(
  strapi: Strapi,
  operationId: number,
): Promise<unknown> {
  if (!(await claimSnappayOperation(strapi, operationId))) {
    return { status: "skipped", reason: "not_due_or_already_claimed" };
  }
  const loaded = await loadOperationBundle(strapi, operationId);
  if (!loaded) {
    await strapi.db.query(OPERATION_UID).update({
      where: { id: operationId },
      data: {
        Status: "Failed",
        leaseUntil: null,
        failureMessage: "Payment operation relations are missing",
      },
    } as any);
    return { status: "failed", reason: "missing_relations" };
  }
  const { operation, bundle } = loaded;

  try {
    if (operation.OperationType === "FINALIZE_EFFECTS") {
      await runSnappaySideEffects(strapi, Number(bundle.attempt.id), Number(bundle.order.id));
      await markOperationSucceeded(strapi, operation.id, "SETTLE");
      return { status: "completed", operationId };
    }
    const operatorAction = operation.metadata?.operatorAction === true;
    if (
      !operatorAction &&
      ["Succeeded", "Cancelled", "Failed", "Expired"].includes(String(bundle.attempt.Status))
    ) {
      await markOperationSucceeded(strapi, operation.id, bundle.attempt.providerStatus);
      return { status: "completed", replayed: true };
    }

    const token = await resolveSnappayPaymentTokenForOperation(strapi, bundle, operation);
    if (!token) {
      if (operatorAction) {
        await markOperatorOperation(
          strapi,
          operation.id,
          "Unknown",
          "SNAPPAY_PAYMENT_TOKEN_MISSING",
          "No provider token is available",
        );
      } else {
        await markManualReview(
          strapi,
          operation,
          bundle,
          "SNAPPAY_PAYMENT_TOKEN_MISSING",
          "No provider token is available",
        );
      }
      return { status: "unknown", reason: "token_missing" };
    }
    const adapter = createSnappayAdapter(strapi);
    const statusResult = await adapter.status(token);
    const providerStatus = normalizeSnappayProviderStatus(statusResult.response?.status);
    await updateProviderObservation(strapi, bundle, statusResult, providerStatus);
    if (operatorAction) {
      if (!statusResult.successful) {
        const code = Number(statusResult.diagnostic.providerCode || 0);
        if (code !== 1007 && code !== 1048 && Number(operation.retryCount || 0) < 1) {
          await scheduleOperatorRetry(
            strapi,
            operation,
            5_000,
            "SnappPay status is temporarily unavailable",
            operationObservation(statusResult, providerStatus),
          );
        } else {
          await markOperatorOperation(
            strapi,
            operation.id,
            "Unknown",
            code ? `SNAPPAY_STATUS_${code}` : "SNAPPAY_STATUS_AMBIGUOUS",
            "Provider status requires manual review",
            operationObservation(statusResult, providerStatus),
          );
        }
        return {
          status: "unknown",
          operationId,
          reason: "provider_status_unavailable",
        };
      }
      if (
        operation.OperationType === "CANCEL" &&
        (providerStatus === "CANCEL" || providerStatus === "REVERT")
      ) {
        await cancelLocallyAndComplete(
          strapi,
          operation,
          bundle,
          providerStatus,
          String(operation.metadata.reason || "operator_cancel"),
        );
        return { status: "completed", operationId, providerStatus };
      }
      if (operation.OperationType === "CANCEL" && providerStatus === "VERIFY") {
        await performSettle(strapi, operation, bundle, token, true);
        return { status: "completed", operationId, providerStatus };
      }
      if (
        operation.OperationType === "UPDATE" &&
        (providerStatus === "CANCEL" || providerStatus === "REVERT")
      ) {
        await applySnappayCancellation(
          strapi,
          idsFrom(bundle),
          providerStatus,
          "provider_cancelled_before_operator_update",
        );
        await markOperatorOperation(
          strapi,
          operation.id,
          "Failed",
          "SNAPPAY_UPDATE_ORDER_CANCELLED",
          "The provider order is already cancelled",
          operationObservation(statusResult, providerStatus),
        );
        return { status: "failed", operationId, providerStatus };
      }
      if (providerStatus !== "SETTLE") {
        await markOperatorOperation(
          strapi,
          operation.id,
          "Unknown",
          "SNAPPAY_OPERATOR_PROVIDER_NOT_SETTLED",
          `Provider status is ${providerStatus}`,
          operationObservation(statusResult, providerStatus),
        );
        return {
          status: "unknown",
          operationId,
          reason: "provider_not_settled",
        };
      }
      if (operation.OperationType === "CANCEL") {
        await performCancel(
          strapi,
          operation,
          bundle,
          token,
          String(operation.metadata.reason || "operator_cancel"),
        );
      } else if (operation.OperationType === "UPDATE") {
        await performOperatorUpdate(strapi, operation, bundle, token);
      } else {
        await markOperatorOperation(
          strapi,
          operation.id,
          "Failed",
          "SNAPPAY_OPERATOR_TYPE_INVALID",
          "Unsupported operator operation",
        );
      }
      return { status: "completed", operationId, providerStatus };
    }
    const callbackState = ["OK", "FAILED"].includes(
      String(operation.metadata?.callbackState || "").toUpperCase(),
    )
      ? (String(operation.metadata.callbackState).toUpperCase() as SnappayCallbackState)
      : undefined;
    const attemptCreatedAt = bundle.attempt.createdAt
      ? new Date(bundle.attempt.createdAt).getTime()
      : null;
    const action = decideSnappayRecovery({
      callbackState,
      providerStatus,
      // Only the code from the status read just performed. Falling back to
      // `operation.providerCode` let a code left behind by an earlier call (a
      // token request, say) decide the recovery action for a status read that
      // never produced one.
      providerCode: statusResult.diagnostic.providerCode,
      attemptAgeMs: attemptCreatedAt !== null ? Date.now() - attemptCreatedAt : null,
    });
    if (action === "MANUAL_REVIEW") {
      const code = Number(statusResult.diagnostic.providerCode || 0);
      const reviewCode =
        code === 1048
          ? "SNAPPAY_VENTURE_MISMATCH"
          : code === 1007
            ? "SNAPPAY_STATUS_NOT_FOUND"
            : "SNAPPAY_MANUAL_REVIEW";
      await markManualReview(
        strapi,
        operation,
        bundle,
        reviewCode,
        "SnappPay provider state requires investigation, not a replacement payment",
      );
      return { status: "completed", operationId, providerStatus, action };
    }
    await executeRecoveryAction(strapi, operation, bundle, token, action);
    return { status: "completed", operationId, providerStatus, action };
  } catch (error: any) {
    const retryCount = Number(operation.retryCount || 0);
    const message = String(error?.message || error).slice(0, 500);
    if (operation.metadata?.operatorAction === true) {
      if (retryCount >= 1) {
        await markOperatorOperation(
          strapi,
          operation.id,
          "Unknown",
          "SNAPPAY_OPERATOR_OPERATION_FAILED",
          message,
        );
      } else {
        await scheduleOperatorRetry(strapi, operation, 5_000, message);
      }
      return { status: "retry_scheduled", operationId };
    }
    if (retryCount >= SNAPPAY_RECONCILIATION_DELAYS_MS.length) {
      await markManualReview(strapi, operation, bundle, "SNAPPAY_OPERATION_FAILED", message);
    } else {
      await scheduleOperationRetry(
        strapi,
        operation,
        bundle,
        reconciliationDelay(retryCount),
        message,
      );
    }
    return { status: "retry_scheduled", operationId };
  }
}

/**
 * Re-queues side effects for attempts that settled but never had them run.
 *
 * `finalizeAndComplete` commits the settlement, then queues a FINALIZE_EFFECTS
 * operation in a separate step. Three things can strand that step: the enqueue
 * throwing, the process dying in between, or the replay short-circuit in
 * `processSnappayOperation` returning early for an already-Succeeded attempt.
 * In every case the customer has paid but their cart is never cleared and the
 * revenue is never reported.
 *
 * `runSnappaySideEffects` is idempotent on `sideEffectsCompletedAt`, and
 * `createOrReuseOperation` is keyed on `effects:{attemptId}`, so re-queueing is
 * safe to repeat.
 */
async function recoverOrphanedSideEffects(strapi: Strapi): Promise<number> {
  let recovered = 0;
  try {
    const stranded: any[] = await strapi.db.query(ATTEMPT_UID).findMany({
      where: {
        Gateway: "snappay",
        Status: "Succeeded",
        sideEffectsCompletedAt: null,
      },
      orderBy: { updatedAt: "asc" },
      limit: 50,
    } as any);

    for (const attempt of stranded || []) {
      const bundle = await loadAttemptBundle(strapi, { id: attempt.id });
      if (!bundle) continue;
      try {
        await queueSideEffects(strapi, bundle);
        recovered += 1;
      } catch (error: any) {
        strapi.log.error("Failed to re-queue stranded SnappPay side effects", {
          attemptId: attempt.attemptId,
          error: String(error?.message || error).slice(0, 300),
        });
      }
    }

    if (recovered > 0) {
      strapi.log.warn("Re-queued SnappPay side effects for settled attempts", {
        count: recovered,
      });
    }
  } catch (error: any) {
    strapi.log.error("Failed to scan for stranded SnappPay side effects", {
      error: String(error?.message || error).slice(0, 300),
    });
  }
  return recovered;
}

export async function sweepSnappayOperations(strapi: Strapi): Promise<{
  queued: number;
  health: {
    verifiedUnsettledOver15m: number;
    manualReview: number;
  };
}> {
  const now = new Date();
  const health = {
    verifiedUnsettledOver15m: 0,
    manualReview: 0,
  };
  try {
    const [verifiedUnsettledOver15m, manualReview] = await Promise.all([
      strapi.db.query(ATTEMPT_UID).count({
        where: {
          Gateway: "snappay",
          Status: { $in: ["Pending", "Unknown"] },
          providerStatus: "VERIFY",
          lastReconciledAt: {
            $lt: new Date(now.getTime() - 15 * 60 * 1000),
          },
        },
      } as any),
      strapi.db.query(OPERATION_UID).count({
        where: {
          Status: "Unknown",
          nextRunAt: null,
        },
      } as any),
    ]);
    health.verifiedUnsettledOver15m = Number(verifiedUnsettledOver15m || 0);
    health.manualReview = Number(manualReview || 0);
    const metrics = (strapi as any).metrics;
    if (typeof metrics?.gauge === "function") {
      metrics.gauge("snappay_verified_unsettled_over_15m")?.set?.(health.verifiedUnsettledOver15m);
      metrics.gauge("snappay_manual_review_operations")?.set?.(health.manualReview);
    }
    if (health.verifiedUnsettledOver15m > 0) {
      strapi.log.error("SnappPay verified transactions remain unsettled", {
        count: health.verifiedUnsettledOver15m,
        thresholdMinutes: 15,
      });
    }
    if (health.manualReview > 0) {
      strapi.log.warn("SnappPay operations require manual review", {
        count: health.manualReview,
      });
    }
  } catch (error: any) {
    strapi.log.error("Failed to read SnappPay reconciliation health", {
      error: String(error?.message || error).slice(0, 300),
    });
  }

  await recoverOrphanedSideEffects(strapi);

  const rows: any[] = await strapi.db.query(OPERATION_UID).findMany({
    where: {
      $or: [
        {
          Status: { $in: ["Queued", "Unknown"] },
          nextRunAt: { $lte: now },
        },
        {
          Status: "Processing",
          leaseUntil: { $lt: now },
        },
      ],
    },
    orderBy: { nextRunAt: "asc" },
    limit: 100,
  } as any);
  let queued = 0;
  for (const row of rows || []) {
    const retryCount = Number(row.retryCount || 0) + (row.Status === "Processing" ? 1 : 0);
    if (row.Status === "Processing") {
      await strapi.db.query(OPERATION_UID).update({
        where: { id: row.id },
        data: {
          Status: "Queued",
          retryCount,
          leaseUntil: null,
          nextRunAt: now,
          failureMessage: "Recovered expired worker lease",
        },
      } as any);
    }
    await enqueueSnappayOperation(Number(row.id), retryCount, 0).then(
      () => {
        queued += 1;
      },
      (error: any) => {
        strapi.log.error("SnappPay sweep enqueue failed", {
          operationId: row.id,
          error: String(error?.message || error).slice(0, 300),
        });
      },
    );
  }
  return { queued, health };
}

export function createSnappayOrchestrator(strapi: Strapi) {
  return {
    assertRuntimeConfig: assertSnappayRuntimeConfig,
    checkEligibility: (amountIrr: number) => checkSnappayEligibility(strapi, amountIrr),
    initiate: (input: Parameters<typeof initiateSnappayPayment>[1]) =>
      initiateSnappayPayment(strapi, input),
    acceptCallback: (input: SnappayCallbackInput) => acceptSnappayCallback(strapi, input),
    reconcileOrder: (orderId: number, reason?: string) =>
      requestSnappayReconciliation(strapi, orderId, reason),
    queueAdminCancel: (input: Parameters<typeof queueSnappayAdminCancel>[1]) =>
      queueSnappayAdminCancel(strapi, input),
    queueAdminUpdate: (input: Parameters<typeof queueSnappayAdminUpdate>[1]) =>
      queueSnappayAdminUpdate(strapi, input),
    processOperation: (operationId: number) => processSnappayOperation(strapi, operationId),
    sweep: () => sweepSnappayOperations(strapi),
  };
}

export default ({ strapi }: { strapi: Strapi }) => createSnappayOrchestrator(strapi);
