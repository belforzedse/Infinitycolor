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
import {
  displaySnappayFingerprint,
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

const ATTEMPT_UID = "api::payment-attempt.payment-attempt" as const;
const TX_UID = "api::contract-transaction.contract-transaction" as const;
const OPERATION_UID = "api::payment-operation.payment-operation" as const;
const ORDER_UID = "api::order.order" as const;
const CONTRACT_UID = "api::contract.contract" as const;
const OPERATION_LEASE_MS = 5 * 60 * 1000;

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

async function resolveSnappayPaymentToken(strapi: Strapi, bundle: AttemptBundle): Promise<string> {
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
  return (
    result.diagnostic.timedOut === true ||
    result.diagnostic.transportError === true ||
    Number(result.diagnostic.httpStatus || 0) >= 500 ||
    result.diagnostic.providerCode === 1007 ||
    result.diagnostic.providerCode === 1009 ||
    result.diagnostic.providerCode === 1048
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
): Promise<AttemptBundle | null> {
  const attempt: any = await strapi.db.query(ATTEMPT_UID).findOne({
    where,
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
  const transaction = [...transactions]
    .reverse()
    .find(
      (candidate: any) =>
        isSnappayGatewayValue(candidate?.external_source) &&
        String(candidate?.external_id || "") === String(attempt.providerReference || ""),
    );
  if (!order || !contract || !transaction) return null;
  return { attempt, order, contract, transaction };
}

async function findAttemptByTransactionId(
  strapi: Strapi,
  transactionId: string,
): Promise<AttemptBundle | null> {
  return loadAttemptBundle(strapi, {
    Gateway: "snappay",
    providerReference: transactionId,
  });
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
  const amount = Math.round(Number(bundle.attempt.Amount || 0));
  if (amount <= 0 || amount !== totalAmount - discountAmount) {
    throw new Error("SNAPPAY_AMOUNT_MISMATCH");
  }

  return {
    amount,
    discountAmount,
    externalSourceAmount: 0,
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
  const amount = Math.round(Number(metadata.newTotalToman || 0) * 10);
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
    amount < 0 ||
    discountAmount < 0 ||
    shippingAmount < 0 ||
    amount > Number(bundle.attempt.Amount) ||
    Number(bundle.contract.Amount) !== expectedOldTotalToman ||
    cartItems.some(
      (item) =>
        !Number.isInteger(item.amount) ||
        item.amount < 0 ||
        !Number.isInteger(item.count) ||
        item.count <= 0,
    ) ||
    amount !== totalAmount - discountAmount
  ) {
    throw new Error("SNAPPAY_ADMIN_UPDATE_AMOUNT_MISMATCH");
  }
  return {
    paymentToken,
    amount,
    discountAmount,
    externalSourceAmount: 0,
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
  const now = new Date();
  await Promise.all([
    strapi.db.query(TX_UID).update({
      where: { id: bundle.transaction.id },
      data: {
        ...(providerStatus ? { GatewayStatus: providerStatus } : {}),
        LastHttpStatus: result.diagnostic.httpStatus,
        LastProviderCode: result.diagnostic.providerCode,
        LastReconciledAt: now,
        GatewayResponse: providerSummary(result),
      },
    } as any),
    strapi.db.query(ATTEMPT_UID).update({
      where: { id: bundle.attempt.id },
      data: {
        ...(providerStatus ? { providerStatus } : {}),
        providerResponse: providerSummary(result),
        lastReconciledAt: now,
      },
    } as any),
  ]);
  bundle.transaction.GatewayStatus = providerStatus || bundle.transaction.GatewayStatus;
  bundle.attempt.providerStatus = providerStatus || bundle.attempt.providerStatus;
}

async function failInitiation(
  strapi: Strapi,
  bundle: AttemptBundle,
  code: string,
  message: string,
): Promise<void> {
  await strapi.db.transaction(async ({ trx }) => {
    await releaseOrderReservation(
      strapi,
      Number(bundle.order.id),
      "Released",
      trx,
    );
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
): Promise<void> {
  await strapi.db.transaction(async ({ trx }) => {
    await strapi.db.query(ATTEMPT_UID).update({
      where: { id: bundle.attempt.id },
      data: {
        Status: "Unknown",
        providerStatus: "UNKNOWN",
        failureCode: code,
        failureMessage: message.slice(0, 500),
        nextAction: "manual_review",
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
    metadata: providerSummary(result),
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

export async function initiateSnappayPayment(
  strapi: Strapi,
  input: {
    paymentAttemptId: number;
    callbackNonce: string;
    mobile?: string;
  },
): Promise<{
  success: boolean;
  status: "Redirected" | "Failed" | "Unknown";
  orderId: number;
  contractId: number;
  transactionId: string;
  redirectUrl?: string;
  errorCode?: string;
  message?: string;
}> {
  if (!isSnappayHardenedInitiationEnabled()) {
    throw new Error("SNAPPAY_HARDENED_INITIATION_DISABLED");
  }
  assertSnappayRuntimeConfig();
  const bundle = await loadAttemptBundle(strapi, {
    id: input.paymentAttemptId,
    Gateway: "snappay",
  });
  if (!bundle) throw new Error("SNAPPAY_ATTEMPT_NOT_FOUND");
  const transactionId = String(bundle.attempt.providerReference || "");
  if (!isValidSnappayTransactionId(transactionId)) {
    throw new Error("SNAPPAY_TRANSACTION_ID_INVALID");
  }
  if (!matchesSnappayCallbackNonce(input.callbackNonce, bundle.attempt.callbackNonceHash)) {
    throw new Error("SNAPPAY_CALLBACK_NONCE_MISMATCH");
  }
  if (bundle.attempt.Status === "Redirected" && bundle.attempt.redirectUrl) {
    return {
      success: true,
      status: "Redirected",
      orderId: Number(bundle.order.id),
      contractId: Number(bundle.contract.id),
      transactionId,
      redirectUrl: bundle.attempt.redirectUrl,
    };
  }
  if (bundle.attempt.Status !== "Pending") {
    return {
      success: false,
      status: bundle.attempt.Status === "Failed" ? "Failed" : "Unknown",
      orderId: Number(bundle.order.id),
      contractId: Number(bundle.contract.id),
      transactionId,
      errorCode: "PAYMENT_IN_PROGRESS",
      message: "SnappPay initiation is already being processed",
    };
  }

  let payload: SnappayTokenRequest;
  try {
    payload = await buildTokenPayload(strapi, bundle, input.mobile, input.callbackNonce);
  } catch (error: any) {
    await failInitiation(
      strapi,
      bundle,
      String(error?.message || "SNAPPAY_PAYLOAD_INVALID").split(":")[0],
      "SnappPay request data is invalid",
    );
    throw error;
  }

  const result = await createSnappayAdapter(strapi).requestPaymentToken(payload);
  if (!result.successful || !result.response?.paymentToken || !result.response?.paymentPageUrl) {
    const code = `SNAPPAY_TOKEN_${
      result.diagnostic.providerCode || result.diagnostic.httpStatus || "FAILED"
    }`;
    if (isAmbiguousResult(result)) {
      await markAttemptUnknown(strapi, bundle, code, "SnappPay token request result is ambiguous");
      await recordTokenOperation(strapi, bundle, "Unknown", result);
      strapi.log.error("SnappPay token initiation requires manual review", {
        attemptId: bundle.attempt.attemptId,
        orderId: bundle.order.id,
        transactionId,
        ...providerSummary(result),
      });
      return {
        success: false,
        status: "Unknown",
        orderId: Number(bundle.order.id),
        contractId: Number(bundle.contract.id),
        transactionId,
        errorCode: "PAYMENT_UNKNOWN",
        message: "نتیجه شروع پرداخت هنوز مشخص نیست",
      };
    }
    await failInitiation(
      strapi,
      bundle,
      code,
      result.errorData?.message || "SnappPay token request failed",
    );
    await recordTokenOperation(strapi, bundle, "Failed", result);
    return {
      success: false,
      status: "Failed",
      orderId: Number(bundle.order.id),
      contractId: Number(bundle.contract.id),
      transactionId,
      errorCode: code,
      message: "شروع پرداخت اسنپ‌پی انجام نشد",
    };
  }

  const paymentToken = String(result.response.paymentToken);
  const tokenHash = snappayTokenFingerprint(paymentToken);
  const now = new Date();
  await strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM contract_transactions WHERE id = ? FOR UPDATE", [
      bundle.transaction.id,
    ]);
    await strapi.db.query(TX_UID).update({
      where: { id: bundle.transaction.id },
      data: {
        // The provider token is stored as-is. It is not exposed to customers:
        // order.ts strips TrackId from every SnappPay order response.
        TrackId: paymentToken,
        GatewayStatus: "PENDING",
        GatewayResponse: {
          ...providerSummary(result),
          tokenFingerprint: displaySnappayFingerprint(tokenHash),
        },
        LastHttpStatus: result.diagnostic.httpStatus,
        LastProviderCode: result.diagnostic.providerCode,
      },
      transacting: trx,
    } as any);
    await strapi.db.query(ATTEMPT_UID).update({
      where: { id: bundle.attempt.id },
      data: {
        Status: "Redirected",
        providerStatus: "PENDING",
        redirectUrl: result.response.paymentPageUrl,
        redirectedAt: now,
        nextAction: "await_callback",
        nextActionAt: null,
        providerResponse: {
          ...providerSummary(result),
          tokenFingerprint: displaySnappayFingerprint(tokenHash),
        },
      },
      transacting: trx,
    } as any);
  });
  await recordTokenOperation(strapi, bundle, "Succeeded", result);
  return {
    success: true,
    status: "Redirected",
    orderId: Number(bundle.order.id),
    contractId: Number(bundle.contract.id),
    transactionId,
    redirectUrl: result.response.paymentPageUrl,
  };
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
  await strapi.db.query(ATTEMPT_UID).update({
    where: { id: bundle.attempt.id },
    data: {
      Status: bundle.attempt.Status === "Redirected" ? "Pending" : bundle.attempt.Status,
      nextAction: input.type.toLowerCase(),
      nextActionAt: nextRunAt,
    },
  } as any);
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
  const nonceMatches =
    isValidSnappayCallbackNonce(nonce) &&
    matchesSnappayCallbackNonce(nonce, bundle?.attempt?.callbackNonceHash);
  if (!bundle || !nonceMatches || Number(bundle.attempt.Amount) !== Number(input.amount)) {
    strapi.log.warn("Rejected uncorrelated SnappPay callback", {
      transactionId,
      state,
      amountMatches: !!bundle && Number(bundle.attempt.Amount) === Number(input.amount),
    });
    return {
      accepted: false,
      redirectUrl: paymentResultUrl(undefined, "invalid_callback"),
      errorCode: "SNAPPAY_CALLBACK_MISMATCH",
    };
  }
  const orderId = Number(bundle.order.id);
  if (["Succeeded", "Cancelled", "Failed", "Expired"].includes(String(bundle.attempt.Status))) {
    return {
      accepted: true,
      orderId,
      redirectUrl: paymentResultUrl(orderId, "recorded"),
    };
  }

  await strapi.db.query(ATTEMPT_UID).update({
    where: { id: bundle.attempt.id },
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
  await createOrReuseOperation(strapi, bundle, {
    type: "RECONCILE",
    idempotencyKey: `reconcile:${bundle.attempt.id}`,
    metadata: {
      callbackState: state,
      callbackReceivedAt: new Date().toISOString(),
    },
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
  const bundle = await loadAttemptBundle(strapi, {
    Gateway: "snappay",
    order: { id: orderId },
  });
  if (!bundle) return null;
  if (["Succeeded", "Cancelled", "Failed", "Expired"].includes(String(bundle.attempt.Status))) {
    return bundle.attempt;
  }
  await createOrReuseOperation(strapi, bundle, {
    type: "RECONCILE",
    idempotencyKey: `reconcile:${bundle.attempt.id}`,
    metadata: { requestedReason: String(reason).slice(0, 100) },
  });
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
  options: { allowParkedForReview?: boolean } = {},
): void {
  if (bundle.order.ShippingBarcode) {
    throw new Error("SNAPPAY_OPERATOR_STATE_INVALID");
  }

  const settled =
    bundle.attempt.Status === "Succeeded" &&
    bundle.attempt.providerStatus === "SETTLE" &&
    bundle.order.Status === "Started";
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
  // that automatic reconciliation parked for manual review.
  assertOperatorBundle(bundle, { allowParkedForReview: true });
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
    return markManualReview(
      strapi,
      operation,
      bundle,
      `SNAPPAY_VERIFY_${code}`,
      "SnappPay verification cannot be reconciled automatically",
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
  if (status === "REGISTERED") {
    return scheduleOperationRetry(
      strapi,
      operation,
      bundle,
      30 * 60 * 1000,
      "SnappPay revert is still registered",
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

    const token = await resolveSnappayPaymentToken(strapi, bundle);
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
      providerCode: statusResult.diagnostic.providerCode || operation.providerCode,
      // A code from a failed status read describes the lookup, not the payment.
      statusObserved: statusResult.successful === true,
      attemptAgeMs: attemptCreatedAt !== null ? Date.now() - attemptCreatedAt : null,
    });
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
