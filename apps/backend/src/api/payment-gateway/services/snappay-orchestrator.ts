import type { Strapi } from "@strapi/strapi";
import { createHash } from "node:crypto";
import * as Sentry from "@sentry/node";
import { formatCancellationReasonForSms } from "../../../services/sms/notifications";
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
  evaluateSnappayNotFound,
  normalizeSnappayProviderStatus,
  SNAPPAY_RECONCILIATION_DELAYS_MS,
  type SnappayCallbackState,
  type SnappayNotFoundConfirmation,
  type SnappayProviderStatus,
  type SnappayRecoveryAction,
} from "./snappay-state-machine";
import {
  getRecoveryMode,
  getRecoveryReadiness,
  recoveryConfig,
  type RecoveryMode,
  type RecoveryPath,
} from "./snappay-recovery-mode";
import { evaluateReleaseBreakers } from "./snappay-recovery-breakers";
import {
  listAttemptsAwaitingFollowup,
  listEvidenceForAttempt,
  listNotFoundReads,
  recordEvidence,
  recordEvidenceSafely,
  summarizeRecentEvidence,
  LATE_SUCCESS_KINDS,
  NOT_FOUND_KINDS,
  REGISTERED_KINDS,
  type EvidenceDecision,
  type EvidenceKind,
  type StoredEvidence,
} from "../../payment-attempt-evidence/services/evidence";
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
import { incrementMetric } from "../../../utils/metrics";
import { auditWalletHoldConsistency } from "../../local-user-wallet/services/wallet-holds";

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
  /**
   * Append-only recovery evidence for this attempt, oldest first.
   *
   * This — not `provider_response.generation.terminalEvidence` — is the source
   * of truth for "we already ended this attempt". The JSON marker is a cache:
   * the observation writer merges shallowly and guards only
   * `status <> 'Succeeded'`, and a generation rotation replaces the whole
   * `generation` object including the marker, so a terminal fact stored only
   * there can be overwritten by any later read.
   *
   * Loaded lazily: only the paths that ask about terminality pay for it.
   */
  evidence?: StoredEvidence[];
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

/**
 * Mint-time identity of the SnappPay environment a token belongs to.
 *
 * A 404/1007 has no body to correlate against, so provenance has to be
 * established locally. These two values are recorded on the generation when the
 * token is issued and compared when a 1007 arrives: a token minted against
 * staging cannot be declared dead by production reading its own (empty)
 * environment, which is the failure mode that would otherwise cancel live
 * orders after a config change.
 */
function snappayEnvironmentIdentity(): { providerHost: string; clientIdFingerprint: string } {
  try {
    const config = getSnappayConfig();
    return {
      providerHost: new URL(config.baseUrl).host,
      clientIdFingerprint: createHash("sha256").update(config.clientId).digest("hex").slice(0, 12),
    };
  } catch {
    return { providerHost: "", clientIdFingerprint: "" };
  }
}

/** Age of the *provider token*, not of the attempt row. */
function snappayTokenAgeMs(bundle: AttemptBundle, now = Date.now()): number {
  const state = readSnappayGenerationState(bundle.attempt.providerResponse);
  const issuedAt =
    state.generation?.dispatchedAt ||
    bundle.attempt.redirectedAt ||
    bundle.attempt.createdAt;
  const parsed = issuedAt ? new Date(issuedAt).getTime() : NaN;
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : 0;
}

/** Newest instant at which the shopper was sent to (or back to) the payment page. */
function snappayResumedAtMs(bundle: AttemptBundle): number | null {
  const parsed = bundle.attempt.redirectedAt
    ? new Date(bundle.attempt.redirectedAt).getTime()
    : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function attemptEvidence(
  strapi: Strapi,
  bundle: AttemptBundle,
): Promise<StoredEvidence[]> {
  if (Array.isArray(bundle.evidence)) return bundle.evidence;
  try {
    bundle.evidence = await listEvidenceForAttempt(strapi, Number(bundle.attempt.id));
  } catch (error: any) {
    strapi.log.error("Failed to load SnappPay recovery evidence", {
      attemptId: bundle.attempt.attemptId,
      error: String(error?.message || error).slice(0, 300),
    });
    bundle.evidence = [];
  }
  return bundle.evidence;
}

/** Evidence kinds written when *we* ended an attempt rather than the provider. */
const SYSTEM_TERMINAL_KINDS: EvidenceKind[] = [
  "not_found_confirmed",
  "failed_then_not_found",
  "registered_reverted",
  "local_ttl",
  "local_ceiling",
];

const LOCALLY_TERMINAL_STATUSES = ["Succeeded", "Cancelled", "Failed", "Expired"];

const attemptIsLocallyTerminal = (attempt: any): boolean =>
  LOCALLY_TERMINAL_STATUSES.includes(String(attempt?.Status || ""));

/**
 * The attempt is over because *we* ended it, and the provider may still be
 * holding a live payment for it.
 *
 * Derived from the order as well as from the evidence rows, because production
 * already contains 27 attempts with a provider FAILED callback followed by 1007
 * and one `CALLBACK_OK`/`Pending` attempt whose order was cancelled 146 hours
 * ago: all of them predate the evidence table, and all of them are exactly the
 * case the late-success matrix exists for. An operator cancellation is excluded
 * — that keeps today's review park, because a human already decided.
 */
async function isSystemCancelledLocally(
  strapi: Strapi,
  bundle: AttemptBundle,
): Promise<boolean> {
  if (String(bundle.attempt.Status || "") === "Succeeded") return false;
  const orderCancelled = String(bundle.order?.Status || "") === "Cancelled";
  if (!attemptIsLocallyTerminal(bundle.attempt) && !orderCancelled) return false;
  const rows = await attemptEvidence(strapi, bundle);
  if (rows.some((row) => SYSTEM_TERMINAL_KINDS.includes(row.kind) && row.decision === "released")) {
    return true;
  }
  // An attempt SnappPay itself reverted or cancelled — including the customer's
  // own abandon button, which goes through `performRevert` — is not a local
  // decision waiting for a late-success handler. The provider has nothing left.
  if (
    rows.some(
      (row) =>
        (row.kind === "provider_cancel" || row.kind === "provider_revert") &&
        row.decision === "observed",
    )
  ) {
    return false;
  }
  return orderCancelled || attemptIsLocallyTerminal(bundle.attempt);
}

function evidenceBaseFields(bundle: AttemptBundle) {
  const state = readSnappayGenerationState(bundle.attempt.providerResponse);
  const legs = readPaymentAttemptLegs(bundle.attempt);
  return {
    attemptId: Number(bundle.attempt.id),
    orderId: Number(bundle.order?.id) || null,
    tokenFingerprint: state.generation?.paymentTokenFingerprint || null,
    generationSeq: state.generation?.seq || state.tokenAttemptSeq || null,
    walletAmountIrr: legs.walletIrr,
    gatewayAmountIrr: legs.gatewayIrr,
  };
}

/**
 * Is this 404/1007 provably about *our* token, in *this* environment?
 *
 * A 404 has no body, so nothing in the answer identifies what it refers to.
 * Every clause below therefore compares what we sent against what we recorded
 * when the token was minted. A token that fails any of them is an
 * investigation, not a slow confirmation — re-reading it would never make it
 * provable — so it keeps today's manual-review park.
 *
 * Legacy tokens minted before provenance was recorded fail closed for the same
 * reason. That costs nothing: NOT_FOUND enforcement cannot be earned until a
 * week of shadow data exists, by which time every live token carries it.
 */
function snappayNotFoundProvenance(
  bundle: AttemptBundle,
  token: string,
  result: SnappayCallResult<any>,
): { ok: boolean; reason: string } {
  const diagnostic = result.diagnostic || ({} as any);
  if (diagnostic.timedOut === true || diagnostic.transportError === true) {
    return { ok: false, reason: "unreadable_call" };
  }
  if (Number(diagnostic.httpStatus || 0) !== 404) {
    return { ok: false, reason: "unexpected_http_status" };
  }
  if (Number(diagnostic.providerCode || 0) !== 1007) {
    return { ok: false, reason: "unexpected_provider_code" };
  }
  if (hasValidatedOkCallback(bundle)) {
    return { ok: false, reason: "ok_callback" };
  }
  const state = readSnappayGenerationState(bundle.attempt.providerResponse);
  const generation = state.generation;
  if (!generation) return { ok: false, reason: "no_generation" };
  if (!generation.paymentToken || generation.paymentToken !== token) {
    return { ok: false, reason: "token_mismatch" };
  }
  const trackId = String(bundle.transaction?.TrackId || "");
  if (!trackId || trackId !== token) {
    return { ok: false, reason: "track_id_mismatch" };
  }
  const activeSeq = state.generation?.seq || state.tokenAttemptSeq || 0;
  if (!generation.seq || generation.seq !== activeSeq) {
    return { ok: false, reason: "stale_generation" };
  }
  const identity = snappayEnvironmentIdentity();
  if (!generation.providerHost || generation.providerHost !== identity.providerHost) {
    return { ok: false, reason: "provider_host_mismatch" };
  }
  if (
    !generation.clientIdFingerprint ||
    generation.clientIdFingerprint !== identity.clientIdFingerprint
  ) {
    return { ok: false, reason: "client_id_mismatch" };
  }
  return { ok: true, reason: "proven" };
}

/**
 * Which NOT_FOUND class this attempt belongs to.
 *
 * A token that received the provider's own FAILED callback and then went
 * missing is a stronger signal than one that simply went missing, so it gets a
 * shorter minimum age — but it is still its own class with its own shadow
 * count, because whether SnappPay lets a shopper retry the same token after a
 * FAILED callback is one of the three open questions in
 * `docs/snappay/not-found-semantics.md`.
 */
const notFoundKindFor = (bundle: AttemptBundle): EvidenceKind =>
  hasFailedCallback(bundle) ? "failed_then_not_found" : "not_found_read";

async function writeEvidence(
  strapi: Strapi,
  bundle: AttemptBundle,
  row: {
    kind: EvidenceKind;
    mode: RecoveryMode;
    decision: EvidenceDecision;
    result?: SnappayCallResult<any>;
    providerStatus?: string | null;
    callbackState?: string | null;
    tokenAgeMs?: number | null;
    details?: Record<string, unknown>;
  },
  trx?: any,
): Promise<{ id: number } | null> {
  const identity = snappayEnvironmentIdentity();
  const payload = {
    ...evidenceBaseFields(bundle),
    kind: row.kind,
    mode: row.mode,
    decision: row.decision,
    providerHost: identity.providerHost,
    clientIdFingerprint: identity.clientIdFingerprint,
    httpStatus: row.result?.diagnostic?.httpStatus ?? null,
    providerCode: row.result?.diagnostic?.providerCode ?? null,
    providerStatus: row.providerStatus ?? null,
    callbackState: row.callbackState ?? null,
    tokenAgeMs: row.tokenAgeMs ?? null,
    observedAt: new Date(),
    details: row.details ?? null,
  } as any;
  // A money-moving decision commits with its financial transaction and must be
  // allowed to abort it; everything else is an audit line that may never fail a
  // recovery run.
  if (trx || row.decision === "released" || row.decision === "reverted") {
    return recordEvidence(strapi, payload, trx);
  }
  return recordEvidenceSafely(strapi, payload);
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
      data: {
        Status: "Cancelled",
        // Never `message` here: it can echo adapter/HTTP error text from
        // SnappPay's own response, which must not reach the customer verbatim.
        CancellationReason: formatCancellationReasonForSms(undefined, "payment_gateway_declined"),
      },
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
      ...snappayEnvironmentIdentity(),
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
  // Reopening the stored payment page puts the shopper back inside the SnappPay
  // flow, so it is a sign of life and the NOT_FOUND confirm sequence must start
  // over. Nothing recorded that before: `redirectedAt` was stamped only when a
  // token was minted, so a resumed session looked identical to an abandoned one
  // and two reads taken around it would have "confirmed" a shopper who was
  // still paying.
  await strapi.db
    .query(ATTEMPT_UID)
    .update({
      where: { id: bundle.attempt.id, Status: { $ne: "Succeeded" } },
      data: { redirectedAt: new Date() },
    } as any)
    .catch((error: any) => {
      strapi.log.warn("Failed to stamp the SnappPay payment-page resume", {
        attemptId: bundle.attempt.attemptId,
        error: String(error?.message || error).slice(0, 300),
      });
    });

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
  // A terminal attempt keeps its resolution. The late-success matrix and the
  // shadow follow-up probe both queue operations against attempts that are
  // already `Cancelled` or `Expired`, and writing `nextAction` back onto one
  // would un-park it — enough, for a parked NOT_FOUND attempt, to stop the
  // reservation sweep recognising it and to defer its stock to the ceiling
  // instead of freeing it at the TTL.
  if (
    input.metadata?.previousGeneration !== true &&
    !attemptIsLocallyTerminal(bundle.attempt)
  ) {
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
      // Same reasoning as the enqueue path above: a queue outage must not
      // un-resolve an attempt that is already terminal.
      attemptIsLocallyTerminal(bundle.attempt)
        ? Promise.resolve(undefined)
        : strapi.db.query(ATTEMPT_UID).update({
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
  const locallyTerminal = attemptIsLocallyTerminal(bundle.attempt);
  const evidence = locallyTerminal ? await attemptEvidence(strapi, bundle) : undefined;
  if (
    locallyTerminal &&
    !snappayProviderPaymentIsUnresolved(bundle.attempt, bundle.transaction.TrackId, evidence)
  ) {
    return {
      accepted: true,
      orderId,
      redirectUrl: paymentResultUrl(orderId, "recorded"),
    };
  }

  // The attempt is over on our side but SnappPay may still be holding a live
  // payment for it — a shopper who completed the flow after the reservation
  // sweep cancelled their order, or after a confirmed NOT_FOUND released their
  // wallet. Production already contains this case: 27 attempts with a FAILED
  // callback followed by 1007, and one `CALLBACK_OK` attempt whose order was
  // cancelled 146 hours ago.
  //
  // Two things must not happen here. The callback must not fall through to the
  // `Status: "Pending" / nextAction: "verify"` write below, which would
  // resurrect a terminal attempt and send the worker to `verify` — the
  // commit-to-fulfil call — for an order whose stock is already gone. And it
  // must not be silently swallowed, which is what would happen if the sweep
  // stamped attempts terminal without this branch existing: a real payment
  // would vanish. So it is recorded and routed to the late-success matrix in
  // every mode; only the automatic revert is mode-gated.
  if (locallyTerminal || String(bundle.order?.Status || "") === "Cancelled") {
    await writeEvidence(strapi, bundle, {
      kind: "late_success_observed",
      mode: getRecoveryMode("late_success"),
      decision: "observed",
      callbackState: state,
      tokenAgeMs: snappayTokenAgeMs(bundle),
      details: { attemptStatus: String(bundle.attempt.Status), source: "callback" },
    });
    await enqueueCallbackReconcile(strapi, bundle, {
      callbackState: state,
      callbackReceivedAt: new Date().toISOString(),
      transactionId,
      locallyCancelled: true,
      purpose: "late_success",
      generationSeq: readSnappayGenerationState(bundle.attempt.providerResponse).generation?.seq,
    });
    strapi.log.error("SnappPay callback arrived for a locally cancelled attempt", {
      attemptId: bundle.attempt.attemptId,
      orderId,
      callbackState: state,
      attemptStatus: String(bundle.attempt.Status),
    });
    return {
      accepted: true,
      orderId,
      redirectUrl: paymentResultUrl(orderId, "processing"),
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

async function queueSnappayReconcileOperation(
  strapi: Strapi,
  orderId: number,
  reason: string,
  options: { customerAbandoned?: boolean },
): Promise<{ attempt: any | null; claimAccepted: boolean }> {
  // An order the customer retried has several SnappPay attempts. Without an
  // explicit order this picked an arbitrary one, so a retry could reconcile a
  // dead attempt and its dead token while the live one sat untouched.
  const bundle = await loadAttemptBundle(
    strapi,
    { Gateway: "snappay", order: { id: orderId } },
    { orderBy: { createdAt: "desc" } },
  );
  if (!bundle) return { attempt: null, claimAccepted: false };
  if (["Succeeded", "Cancelled", "Failed", "Expired"].includes(String(bundle.attempt.Status))) {
    // Already resolved: whatever the shopper is claiming, this attempt's money
    // and hold have stopped moving and the status response tells them so.
    return { attempt: bundle.attempt, claimAccepted: false };
  }
  const key = `reconcile:${bundle.attempt.id}`;
  const existing: any = await strapi.db.query(OPERATION_UID).findOne({
    where: { idempotencyKey: key },
  } as any);
  // The shopper's own successful return outranks them later saying they did not
  // pay, so the claim is dropped at the door rather than carried to a state
  // machine that would ignore it anyway — and the caller can then tell the
  // shopper the truth about what was recorded.
  //
  // The operation's metadata is the authority here, because it is what
  // `decideSnappayRecovery` actually reads and it is never unset. The attempt's
  // own columns are only corroborating: `updateProviderObservation` overwrites
  // `CALLBACK_OK` with the first non-UNKNOWN status read, so after one worker
  // pass an attempt behind an OK callback reads plain `PENDING` again. Keying
  // only on those would accept a claim the state machine then discards, and the
  // shopper would be promised a release that was never coming.
  const claimAccepted =
    options.customerAbandoned === true &&
    String(existing?.metadata?.callbackState || "").toUpperCase() !== "OK" &&
    String(bundle.attempt.providerStatus || "") !== "CALLBACK_OK" &&
    String(bundle.attempt.nextAction || "") !== "verify";
  const metadata: Record<string, unknown> = {
    requestedReason: String(reason).slice(0, 100),
    // Sticky by design: `requeueParkedSnappayReconcile` merges metadata into the
    // existing row, so a shopper's abandonment survives the quiet status polls
    // the result page keeps firing afterwards and still decides the retry that
    // finally reads a terminal provider state.
    ...(claimAccepted ? { customerAbandoned: true } : {}),
  };
  if (!existing) {
    await createOrReuseOperation(strapi, bundle, {
      type: "RECONCILE",
      idempotencyKey: key,
      metadata,
    });
    return { attempt: bundle.attempt, claimAccepted };
  }
  await resumeExistingReconcile(strapi, bundle, existing, metadata);
  return { attempt: bundle.attempt, claimAccepted };
}

/** Minimum gap between two storefront-triggered pulls of the same attempt. */
const STOREFRONT_PULL_THROTTLE_MS = 60_000;

/**
 * Nudges the reconcile for an attempt whose hold the shopper is currently
 * looking at.
 *
 * The storefront polls `/local-user-wallet/me` and the checkout quote far more
 * often than the reconciliation ladder runs, so a customer sitting on the
 * wallet page would otherwise wait out a 40-minute backoff to learn their money
 * is back. This lets a page view move the work forward without becoming the
 * work: it never calls SnappPay on the request path, it is throttled per
 * attempt, and the resulting run is marked as a pull so it cannot consume a
 * ladder slot.
 *
 * Returns whether a pull was actually issued. Callers ignore it; it exists for
 * the tests and the metric.
 */
export async function requestSnappayStorefrontPull(
  strapi: Strapi,
  attemptDbId: number,
): Promise<boolean> {
  try {
    const operation: any = await strapi.db.query(OPERATION_UID).findOne({
      where: {
        attemptKey: attemptDbId,
        OperationType: "RECONCILE",
        Status: { $in: ["Queued", "Processing", "Unknown"] },
      },
      orderBy: { id: "desc" },
    } as any);
    if (!operation?.id) return false;

    const lastPullMs = operation.metadata?.lastCustomerPullAt
      ? new Date(operation.metadata.lastCustomerPullAt).getTime()
      : 0;
    if (Number.isFinite(lastPullMs) && Date.now() - lastPullMs < STOREFRONT_PULL_THROTTLE_MS) {
      return false;
    }

    const outcome = await requeueParkedSnappayReconcile(strapi, {
      operationId: Number(operation.id),
      attemptId: attemptDbId,
      metadata: { lastCustomerPullAt: new Date().toISOString() },
      nextRunAt: new Date(),
    });
    if (!shouldEnqueueSnappayReconcileResume(outcome)) return false;
    await enqueueSnappayOperation(
      Number(operation.id),
      Number(operation.retryCount || 0),
      0,
      { jobIdSalt: "pull" },
    );
    incrementMetric(strapi, "checkout.wallet_hold_self_heal_pull");
    return true;
  } catch (error: any) {
    // A page decoration must never fail the page.
    strapi.log.warn("Storefront-triggered SnappPay pull failed", {
      attemptDbId,
      error: String(error?.message || error).slice(0, 300),
    });
    return false;
  }
}

export async function requestSnappayReconciliation(
  strapi: Strapi,
  orderId: number,
  reason = "manual",
  options: { customerAbandoned?: boolean } = {},
): Promise<any | null> {
  const { attempt } = await queueSnappayReconcileOperation(strapi, orderId, reason, options);
  return attempt;
}

/**
 * The shopper says they did not pay, and wants their wallet credit and stock
 * back.
 *
 * This is the customer-side counterpart of `queueSnappayAdminCancel`, and the
 * answer to the one gap wallet holds had: `isSupersedableHoldRow` refuses to
 * reclaim a SnappPay hold on the checkout path — SnappPay mints a transaction
 * id the moment an attempt is created, keeps reporting `REGISTERED` long after
 * the shopper has gone, and must never be probed synchronously while a shopper
 * waits. Until now nothing but an operator or the 1.5h reservation defer
 * ceiling could resolve that, so a shopper who opened SnappPay with a wallet
 * split and pressed back had their credit pinned for up to an hour and a half.
 *
 * It is deliberately only a *request*: it queues the same RECONCILE the return
 * paths queue, flagged with the shopper's claim, and the worker still reads
 * `GET /status` before doing anything. The claim can only turn `REGISTERED` or
 * `PENDING` into a revert; every state in which SnappPay says the payment
 * happened is settled and honoured instead, so a shopper who pays and then
 * clicks this keeps their order. Nothing here touches the wallet — the hold is
 * released by `applySnappayCancellation` -> `releaseOrderReservation`, once the
 * provider has actually answered.
 *
 * `accepted: false` means the claim was not recorded — the attempt is already
 * resolved, or the shopper's own browser already came back `OK` and that
 * outranks this. The caller must not then tell them a release is on its way.
 */
export async function requestSnappayCustomerAbandon(
  strapi: Strapi,
  orderId: number,
  reason = "customer_abandoned_checkout",
): Promise<{ accepted: boolean; attempt: any | null }> {
  const { attempt, claimAccepted } = await queueSnappayReconcileOperation(
    strapi,
    orderId,
    reason,
    { customerAbandoned: true },
  );
  return { accepted: claimAccepted, attempt };
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

/**
 * Parks the *attempt* for review, leaving the operation alone.
 *
 * Split out of `markManualReview` because the NOT_FOUND confirm protocol needs
 * exactly this half: the attempt must stay `nextAction = "manual_review"` in
 * every mode, because `isSnappayAttemptParkedForReview` is what makes the
 * reservation sweep release stock and wallet at the 30-minute TTL instead of
 * deferring them to the 1.5-hour ceiling. Changing that field would itself be a
 * reservation mutation caused by a NOT_FOUND decision, which shadow mode is not
 * allowed to make.
 */
async function parkAttemptForReview(
  strapi: Strapi,
  bundle: AttemptBundle,
  code: string,
  message: string,
) {
  await updateAttemptUnlessSettled(strapi, bundle, {
    Status: "Unknown",
    nextAction: "manual_review",
    nextActionAt: null,
    failureCode: code,
    failureMessage: message.slice(0, 500),
    lastReconciledAt: new Date(),
  });
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
    parkAttemptForReview(strapi, bundle, code, message),
  ]);
  strapi.log.error("SnappPay operation requires manual review", {
    operationId: operation.id,
    attemptId: bundle.attempt.attemptId,
    orderId: bundle.order.id,
    transactionId: bundle.attempt.providerReference,
    code,
  });
}

/**
 * Re-schedules a reconcile operation *without* advancing the retry ladder.
 *
 * The confirming re-read is not a retry — nothing failed — so it must not
 * consume one of the five ladder slots, or a token would exhaust its
 * reconciliation budget while waiting to be confirmed. The BullMQ job id is
 * salted per read for the same reason the existing `"pull"` salt exists: the id
 * carries a one-minute bucket, so two schedules for the same operation inside
 * one minute would otherwise dedupe and the later one would silently never run.
 */
async function rescheduleOperationWithoutRetry(
  strapi: Strapi,
  operation: any,
  input: {
    delayMs: number;
    metadata: Record<string, unknown>;
    jobIdSalt: string;
    reason: string;
  },
): Promise<Date> {
  const nextRunAt = new Date(Date.now() + Math.max(0, input.delayMs));
  await strapi.db.query(OPERATION_UID).update({
    where: { id: operation.id },
    data: {
      Status: "Queued",
      nextRunAt,
      leaseUntil: null,
      failureMessage: input.reason.slice(0, 500),
      metadata: {
        ...(operation.metadata || {}),
        ...input.metadata,
        scheduledFor: nextRunAt.toISOString(),
      },
    },
  } as any);
  await enqueueSnappayOperation(
    Number(operation.id),
    Number(operation.retryCount || 0),
    Math.max(0, input.delayMs),
    { jobIdSalt: input.jobIdSalt },
  ).catch((error: any) => {
    strapi.log.error("Failed to enqueue SnappPay follow-up read", {
      operationId: operation.id,
      jobIdSalt: input.jobIdSalt,
      error: String(error?.message || error).slice(0, 300),
    });
  });
  return nextRunAt;
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

/**
 * Did this run happen because the ladder scheduled it, or because something
 * pulled it forward?
 *
 * Result-page polling (every fourth tick), the reservation sweep's deferral
 * tick, the storefront self-heal and a bare-GET return all call
 * `reconcileOrder`, which re-queues the operation to *now*. Counting those runs
 * as retries is why production attempts reach `RECONCILIATION_EXHAUSTED` after
 * a median of 10 minutes instead of running the intended 5m/40m/3h/12h/24h
 * ladder: a customer watching the result page burns their own recovery budget.
 *
 * A pulled run therefore reschedules at the same ladder index. The five-second
 * tolerance absorbs the gap between the scheduled instant and the worker
 * actually claiming the job.
 */
function operationRunWasPulled(operation: any, now = Date.now()): boolean {
  const metadata = operation?.metadata || {};
  const scheduledForMs = metadata.scheduledFor ? new Date(metadata.scheduledFor).getTime() : NaN;
  if (!Number.isFinite(scheduledForMs)) {
    // No recorded schedule: fall back to the pull marker alone, so operations
    // created before this accounting existed keep today's behaviour.
    return Boolean(metadata.pulledAt);
  }
  // Running before the ladder asked for it *is* the signal — a pull sets both
  // `next_run_at` and `pulledAt` to now, so the run lands early. The five-second
  // tolerance absorbs the gap between the scheduled instant and the worker
  // claiming the job.
  return now < scheduledForMs - 5_000;
}

/**
 * Wall-clock bound on reconciliation, independent of the retry count.
 *
 * With pulled runs no longer advancing the ladder, a token that is polled often
 * enough could otherwise be reconciled indefinitely. This ends it at
 * `SNAPPAY_RECONCILE_MAX_AGE_HOURS` regardless of how many slots remain.
 */
function reconciliationExceededMaxAge(bundle: AttemptBundle, now = Date.now()): boolean {
  const createdAt = bundle.attempt?.createdAt ? new Date(bundle.attempt.createdAt).getTime() : NaN;
  if (!Number.isFinite(createdAt)) return false;
  return now - createdAt > recoveryConfig().reconcileMaxAgeHours * 60 * 60 * 1000;
}

async function scheduleOperationRetry(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  delayMs: number,
  reason: string,
) {
  if (reconciliationExceededMaxAge(bundle)) {
    return markManualReview(
      strapi,
      operation,
      bundle,
      "SNAPPAY_RECONCILIATION_EXHAUSTED",
      `Automatic reconciliation passed its wall-clock bound: ${reason}`.slice(0, 500),
    );
  }
  if (isSnappayReconciliationExhausted(operation.retryCount)) {
    return markManualReview(
      strapi,
      operation,
      bundle,
      "SNAPPAY_RECONCILIATION_EXHAUSTED",
      `Automatic reconciliation exhausted: ${reason}`.slice(0, 500),
    );
  }
  const pulled = operationRunWasPulled(operation);
  const retryCount = pulled
    ? Number(operation.retryCount || 0)
    : Number(operation.retryCount || 0) + 1;
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
        metadata: {
          ...(operation.metadata || {}),
          // Recorded so the *next* run can tell a scheduled execution from a
          // pulled one. Without it every run looks scheduled and the ladder
          // burns exactly as it does today.
          scheduledFor: nextRunAt.toISOString(),
          pulledAt: null,
        },
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
  await enqueueSnappayOperation(Number(operation.id), retryCount, delayMs, {
    // A pulled run reschedules at the same retry index, so the job id would
    // otherwise collide with the one already queued for this minute bucket and
    // BullMQ would drop the new schedule.
    ...(pulled ? { jobIdSalt: "resched" } : {}),
  }).catch((error: any) => {
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

async function performRevert(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  token: string,
  // Names what authorized the revert, so an order log distinguishes the
  // provider's own FAILED callback from the shopper abandoning the payment.
  reason = "failed_callback",
) {
  const adapter = createSnappayAdapter(strapi);
  const revertResult = await adapter.revert(token);
  if (revertResult.successful) {
    await updateProviderObservation(strapi, bundle, revertResult, "REVERT");
    return cancelLocallyAndComplete(strapi, operation, bundle, "REVERT", reason);
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
    return performCancel(strapi, operation, bundle, token, `${reason}_already_settled`);
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

/** Closes the operation without touching the attempt. */
async function parkOperationOnly(
  strapi: Strapi,
  operation: any,
  code: string,
  message: string,
) {
  await strapi.db.query(OPERATION_UID).update({
    where: { id: operation.id },
    data: {
      Status: "Unknown",
      leaseUntil: null,
      nextRunAt: null,
      failureMessage: `${code}:${message}`.slice(0, 500),
    },
  } as any);
}

type RecoveryContext = {
  notFoundKind: EvidenceKind;
  notFoundMode: RecoveryMode;
  registeredMode: RecoveryMode;
  lateSuccessMode: RecoveryMode;
  tokenAgeMs: number;
  statusResult: SnappayCallResult<any>;
  providerStatus: SnappayProviderStatus;
  callbackState?: SnappayCallbackState;
  provenance: { ok: boolean; reason: string };
  locallyCancelled: boolean;
};

/**
 * A proven 1007 that is not yet confirmable.
 *
 * The attempt is parked exactly as today — `Unknown` / `manual_review` /
 * `SNAPPAY_STATUS_NOT_FOUND` — in shadow *and* enforce, so the reservation
 * sweep still ends it at the 30-minute TTL and neither mode changes what the
 * customer experiences until a release is actually earned. Only the operation
 * differs: instead of parking with `next_run_at NULL` and never being looked at
 * again, it is scheduled for the confirming re-read.
 */
async function handleConfirmNotFound(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  context: RecoveryContext,
): Promise<void> {
  const config = recoveryConfig();
  const minAgeMs =
    context.notFoundKind === "failed_then_not_found"
      ? config.failedNotFoundMinTokenAgeMs
      : config.notFoundMinTokenAgeMs;

  await writeEvidence(strapi, bundle, {
    kind: context.notFoundKind,
    mode: context.notFoundMode,
    decision: context.provenance.ok ? "observed" : "refused_unproven",
    result: context.statusResult,
    callbackState: context.callbackState ?? null,
    tokenAgeMs: context.tokenAgeMs,
    details: { provenance: context.provenance.reason },
  });

  await parkAttemptForReview(
    strapi,
    bundle,
    context.provenance.ok ? "SNAPPAY_STATUS_NOT_FOUND" : "SNAPPAY_STATUS_NOT_FOUND_UNPROVEN",
    "SnappPay reports no transaction for this token; confirming before any release",
  );

  const reads = await listNotFoundReads(strapi, Number(bundle.attempt.id), context.notFoundKind);
  const firstReadAt = reads[0]?.observedAt ?? new Date().toISOString();
  const delayMs = Math.max(minAgeMs - context.tokenAgeMs, config.notFoundConfirmDelayMs);
  const nextRunAt = await rescheduleOperationWithoutRetry(strapi, operation, {
    delayMs,
    jobIdSalt: `confirm${Math.min(99, reads.length)}`,
    reason: "Confirming a SnappPay NOT_FOUND read before any release",
    metadata: {
      purpose: "confirm_not_found",
      confirmNotFound: { firstReadAt, reads: reads.length },
    },
  });
  strapi.log.warn(
    `SnappPay NOT_FOUND read recorded ${JSON.stringify({
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order?.id,
      mode: context.notFoundMode,
      kind: context.notFoundKind,
      reads: reads.length,
      tokenAgeMs: context.tokenAgeMs,
      minAgeMs,
      confirmAt: nextRunAt.toISOString(),
    })}`,
  );
}

/**
 * A confirmed 1007. In enforce this is the local cancel that frees the wallet
 * and the stock; in shadow it is the row that proves it would have.
 *
 * There is no provider call: a token SnappPay has no record of cannot be
 * reverted or cancelled, so the decision is entirely local. That is also why a
 * crash here is harmless — the next confirming read repeats it.
 */
async function handleCancelLocalNotFound(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  context: RecoveryContext,
): Promise<void> {
  const legs = readPaymentAttemptLegs(bundle.attempt);
  const confirmedKind: EvidenceKind =
    context.notFoundKind === "failed_then_not_found"
      ? "failed_then_not_found"
      : "not_found_confirmed";

  const breaker = await evaluateReleaseBreakers(strapi, {
    path: "not_found",
    kinds: NOT_FOUND_KINDS,
    walletAmountIrr: legs.walletIrr,
  });

  if (breaker.open && context.notFoundMode === "enforce") {
    await writeEvidence(strapi, bundle, {
      kind: confirmedKind,
      mode: context.notFoundMode,
      decision: breaker.decision,
      result: context.statusResult,
      tokenAgeMs: context.tokenAgeMs,
      details: { reason: breaker.reason },
    });
    // Parked exactly as an unconfirmed read is, so the reservation sweep still
    // ends the attempt at its usual TTL. A tripped breaker costs latency, never
    // money.
    return markManualReview(
      strapi,
      operation,
      bundle,
      "SNAPPAY_AUTO_RELEASE_BREAKER",
      `Automatic release refused: ${breaker.reason}`,
    );
  }

  if (context.notFoundMode !== "enforce") {
    // Shadow records the decision it reached, and notes separately whether a
    // breaker would have stopped it.
    //
    // It deliberately does *not* downgrade the row to `refused_breaker_*`: the
    // wallet-value breaker is fail-closed and unset by default, so a shadow run
    // on a wallet-bearing attempt would otherwise never produce a
    // `would_release` row — and "≥ 100 would_release rows" is the prerequisite
    // for ever enabling enforcement. The breaker would have made enforcement
    // safe; suppressing the measurement would only have made it unreachable.
    await writeEvidence(strapi, bundle, {
      kind: confirmedKind,
      mode: context.notFoundMode,
      decision: "would_release",
      result: context.statusResult,
      callbackState: context.callbackState ?? null,
      tokenAgeMs: context.tokenAgeMs,
      details: {
        wouldReleaseWalletIrr: legs.walletIrr,
        breakerWouldRefuse: breaker.open ? breaker.reason : null,
      },
    });
    Sentry.captureMessage("snappay.not_found.shadow_decision", {
      level: "info",
      tags: { kind: confirmedKind, gateway: "snappay" },
      extra: {
        attemptId: bundle.attempt.attemptId,
        orderId: bundle.order?.id,
        tokenAgeMs: context.tokenAgeMs,
        walletAmountIrr: legs.walletIrr,
      },
    });
    return markManualReview(
      strapi,
      operation,
      bundle,
      "SNAPPAY_STATUS_NOT_FOUND",
      "SnappPay NOT_FOUND confirmed; shadow mode made no change",
    );
  }

  await applySnappayCancellation(
    strapi,
    idsFrom(bundle),
    "NOT_FOUND",
    "provider_not_found_confirmed",
    {
      walletReleaseReason: "provider_not_found_confirmed",
      // Written inside the cancellation transaction, so the row exists if and
      // only if the release committed — and a duplicate violates the partial
      // unique index and aborts the whole cancel instead of releasing twice.
      evidence: {
        ...evidenceBaseFields(bundle),
        kind: confirmedKind,
        mode: "enforce",
        decision: "released",
        httpStatus: context.statusResult.diagnostic?.httpStatus ?? null,
        providerCode: context.statusResult.diagnostic?.providerCode ?? null,
        providerStatus: "NOT_FOUND",
        callbackState: context.callbackState ?? null,
        tokenAgeMs: context.tokenAgeMs,
        observedAt: new Date(),
        details: { reads: operation.metadata?.confirmNotFound?.reads ?? null },
      },
    },
  );
  bundle.attempt.Status = "Cancelled";
  await markOperationSucceeded(strapi, operation.id, "NOT_FOUND");
  Sentry.captureMessage("snappay.not_found.auto_released", {
    level: "info",
    tags: { kind: confirmedKind, gateway: "snappay" },
    extra: {
      attemptId: bundle.attempt.attemptId,
      orderId: bundle.order?.id,
      tokenAgeMs: context.tokenAgeMs,
      walletAmountIrr: legs.walletIrr,
    },
  });
}

/**
 * An aged `REGISTERED` token.
 *
 * `REGISTERED` means the shopper never reached the first-installment bank step,
 * and revert cannot touch a `registered` token — SnappPay answers 1011 with
 * "consider the order not finalized and wait 30 min to revert it again". So
 * this loop cannot end a session a shopper is still inside; it can only
 * establish that there is nothing to end.
 *
 * The status read that produced `REGISTERED` in this same run *is* the required
 * pre-check: it happened moments ago in `processSnappayOperation`, so a second
 * call would add a round trip without adding a guarantee. The revert is never
 * blind.
 */
async function handleRevertRegisteredAged(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  token: string,
  context: RecoveryContext,
): Promise<void> {
  const legs = readPaymentAttemptLegs(bundle.attempt);

  if (context.registeredMode !== "enforce") {
    // Same reasoning as the NOT_FOUND shadow row: record the decision, note the
    // breaker beside it, and leave the readiness statistics computable.
    const wouldRefuse = await evaluateReleaseBreakers(strapi, {
      path: "registered",
      kinds: REGISTERED_KINDS,
      walletAmountIrr: legs.walletIrr,
    });
    await writeEvidence(strapi, bundle, {
      kind: "registered_aged",
      mode: context.registeredMode,
      decision: "would_revert",
      result: context.statusResult,
      providerStatus: "REGISTERED",
      tokenAgeMs: context.tokenAgeMs,
      details: {
        wouldReleaseWalletIrr: legs.walletIrr,
        breakerWouldRefuse: wouldRefuse.open ? wouldRefuse.reason : null,
      },
    });
    Sentry.captureMessage("snappay.registered.shadow_decision", {
      level: "info",
      tags: { gateway: "snappay" },
      extra: {
        attemptId: bundle.attempt.attemptId,
        orderId: bundle.order?.id,
        tokenAgeMs: context.tokenAgeMs,
      },
    });
    // Falls through to today's outcome: keep reconciling, let the sweep bound it.
    return scheduleOperationRetry(
      strapi,
      operation,
      bundle,
      reconciliationDelay(Number(operation.retryCount || 0)),
      "SnappPay token is still registered",
    );
  }

  const breaker = await evaluateReleaseBreakers(strapi, {
    path: "registered",
    kinds: REGISTERED_KINDS,
    walletAmountIrr: legs.walletIrr,
  });
  if (breaker.open) {
    await writeEvidence(strapi, bundle, {
      kind: "registered_aged",
      mode: "enforce",
      decision: breaker.decision,
      result: context.statusResult,
      providerStatus: "REGISTERED",
      tokenAgeMs: context.tokenAgeMs,
      details: { reason: breaker.reason },
    });
    return markManualReview(
      strapi,
      operation,
      bundle,
      "SNAPPAY_AUTO_RELEASE_BREAKER",
      `Automatic revert refused: ${breaker.reason}`,
    );
  }

  await writeEvidence(strapi, bundle, {
    kind: "registered_aged",
    mode: "enforce",
    decision: "observed",
    result: context.statusResult,
    providerStatus: "REGISTERED",
    tokenAgeMs: context.tokenAgeMs,
  });

  const adapter = createSnappayAdapter(strapi);
  const revertResult = await adapter.revert(token);
  await updateProviderObservation(
    strapi,
    bundle,
    revertResult,
    revertResult.successful ? "REVERT" : undefined,
  );
  if (revertResult.successful) {
    await applySnappayCancellation(
      strapi,
      idsFrom(bundle),
      // Not "REVERT": that reads as "SnappPay reverted this", which is how a
      // FAILED-callback revert is recorded. This one says *we* decided an aged
      // registered token was never going to be paid, and the order log and
      // failure code say so.
      "REGISTERED_REVERTED",
      "registered_reverted",
      {
        walletReleaseReason: "registered_reverted",
        evidence: {
          ...evidenceBaseFields(bundle),
          kind: "registered_reverted",
          mode: "enforce",
          decision: "reverted",
          httpStatus: revertResult.diagnostic?.httpStatus ?? null,
          providerCode: revertResult.diagnostic?.providerCode ?? null,
          providerStatus: "REVERT",
          tokenAgeMs: context.tokenAgeMs,
          observedAt: new Date(),
        },
      },
    );
    bundle.attempt.Status = "Cancelled";
    await markOperationSucceeded(strapi, operation.id, "REVERT");
    Sentry.captureMessage("snappay.registered.reverted", {
      level: "info",
      tags: { gateway: "snappay" },
      extra: { attemptId: bundle.attempt.attemptId, orderId: bundle.order?.id },
    });
    return;
  }

  const code = Number(revertResult.diagnostic?.providerCode || 0);
  const reportedStatus = revertResult.diagnostic?.transactionStatus;
  if (code === 1007) {
    // The token vanished between the pre-check and the revert. That is the
    // NOT_FOUND class, not a revert failure.
    return handleConfirmNotFound(strapi, operation, bundle, {
      ...context,
      statusResult: revertResult,
    });
  }
  if (code === 1011 && (reportedStatus === "REGISTERED" || !reportedStatus)) {
    // Workbook revert/1011 from `registered`: wait 30 minutes and try again.
    // An unrecognised body is deliberately treated the same way rather than as
    // "never reached the bank" — the field name is unverified against a live
    // 1011, and mistaking an unparsed body for a terminal answer would turn an
    // ambiguous revert into a false unpaid decision.
    await writeEvidence(strapi, bundle, {
      kind: "registered_aged",
      mode: "enforce",
      decision: "observed",
      result: revertResult,
      providerStatus: reportedStatus ?? "REGISTERED",
      tokenAgeMs: context.tokenAgeMs,
      details: { revertRetryInMinutes: 30, transactionStatus: reportedStatus ?? null },
    });
    return scheduleOperationRetry(
      strapi,
      operation,
      bundle,
      recoveryConfig().registeredRevertAfterMs,
      "SnappPay revert is still registered; waiting before retrying",
    );
  }
  return markActionManualReview(
    strapi,
    operation,
    bundle,
    code ? `SNAPPAY_REGISTERED_REVERT_${code}` : "SNAPPAY_REGISTERED_REVERT_AMBIGUOUS",
    "SnappPay refused to revert an aged registered token",
    operationObservation(revertResult, reportedStatus),
  );
}

/**
 * The provider still holds a live payment for an attempt we already ended.
 *
 * Nothing here may touch the wallet, the order or the stock: invariant 3 and
 * `SNAPPAY_LOCAL_STATE_CONFLICT` keep a locally cancelled order unfulfillable,
 * and the customer's money was returned when we cancelled. The only question is
 * what to do on SnappPay's side, and the answer is strictly what SnappPay
 * documents an operation for.
 *
 * This deliberately does *not* reuse `performRevert`: that function falls
 * through a `VERIFY` status to `performSettle(..., true)`, which would settle
 * the payment and then cancel it — creating and voiding a real installment
 * contract for a customer who is not getting the goods.
 */
async function handleLateSuccess(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  token: string,
  context: RecoveryContext,
  action: "LATE_SUCCESS_REVERT" | "LATE_SUCCESS_REVIEW",
): Promise<void> {
  const reviewTags = {
    gateway: "snappay",
    state: context.providerStatus,
    ...(context.providerStatus === "VERIFY" ? { deadline: "nightly_settle" } : {}),
  };

  const park = async (kind: EvidenceKind, decision: EvidenceDecision, detail: string) => {
    await writeEvidence(strapi, bundle, {
      kind,
      mode: context.lateSuccessMode,
      decision,
      result: context.statusResult,
      providerStatus: context.providerStatus,
      callbackState: context.callbackState ?? null,
      tokenAgeMs: context.tokenAgeMs,
      details: { detail },
    });
    Sentry.captureMessage("snappay.late_success.review", {
      level: "warning",
      tags: reviewTags,
      extra: {
        attemptId: bundle.attempt.attemptId,
        orderId: bundle.order?.id,
        providerStatus: context.providerStatus,
        detail,
      },
    });
    // Only the operation is parked. The attempt is already terminal and must
    // stay that way: writing to it would un-resolve a cancelled checkout.
    await parkOperationOnly(
      strapi,
      operation,
      "SNAPPAY_LATE_SUCCESS_REVIEW",
      `Provider is ${context.providerStatus} on a locally cancelled attempt`,
    );
  };

  if (action === "LATE_SUCCESS_REVIEW") {
    // `cancel` is documented and proven from `SETTLE` (10 operator cancels on
    // production), but voiding a live installment contract the customer is now
    // paying off is an operator's decision.
    return park("late_success_review", "review", "settled_contract_needs_operator");
  }

  if (context.lateSuccessMode !== "enforce") {
    return park(
      "late_success_observed",
      "would_revert",
      `revert_available_from_${context.providerStatus}`,
    );
  }

  const adapter = createSnappayAdapter(strapi);
  const revertResult = await adapter.revert(token);
  if (revertResult.successful) {
    await writeEvidence(strapi, bundle, {
      kind: "late_success_reverted",
      mode: "enforce",
      decision: "reverted",
      result: revertResult,
      providerStatus: "REVERT",
      callbackState: context.callbackState ?? null,
      tokenAgeMs: context.tokenAgeMs,
      details: { revertedFrom: context.providerStatus },
    });
    await markOperationSucceeded(strapi, operation.id, "REVERT");
    Sentry.captureMessage("snappay.late_success.reverted", {
      level: "warning",
      tags: reviewTags,
      extra: {
        attemptId: bundle.attempt.attemptId,
        orderId: bundle.order?.id,
        revertedFrom: context.providerStatus,
      },
    });
    return;
  }

  // A failed revert from `VERIFY` is time-critical: SnappPay auto-settles a
  // lingering verify overnight, so an operator has until then to act.
  return park(
    "late_success_review",
    "review",
    `revert_failed_from_${context.providerStatus}`,
  );
}

async function handleObserve(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  context: RecoveryContext,
): Promise<void> {
  const kind: EvidenceKind =
    context.providerStatus === "CANCEL"
      ? "provider_cancel"
      : context.providerStatus === "REVERT"
        ? "provider_revert"
        : "late_success_observed";
  await writeEvidence(strapi, bundle, {
    kind,
    mode: context.lateSuccessMode,
    decision: "observed",
    result: context.statusResult,
    providerStatus: context.providerStatus,
    callbackState: context.callbackState ?? null,
    tokenAgeMs: context.tokenAgeMs,
  });
  await markOperationSucceeded(strapi, operation.id, context.providerStatus);
}

async function executeRecoveryAction(
  strapi: Strapi,
  operation: any,
  bundle: AttemptBundle,
  token: string,
  action: SnappayRecoveryAction,
  revertReason = "failed_callback",
  context?: RecoveryContext,
) {
  switch (action) {
    case "VERIFY":
      return performVerify(strapi, operation, bundle, token);
    case "SETTLE":
      return performSettle(strapi, operation, bundle, token, false);
    case "SETTLE_THEN_CANCEL":
      return performSettle(strapi, operation, bundle, token, true);
    case "REVERT":
      return performRevert(strapi, operation, bundle, token, revertReason);
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
    case "CONFIRM_NOT_FOUND":
      if (!context) return markManualReview(strapi, operation, bundle, "SNAPPAY_STATUS_NOT_FOUND", "SnappPay reports no transaction for this token");
      return handleConfirmNotFound(strapi, operation, bundle, context);
    case "CANCEL_LOCAL_NOT_FOUND":
      if (!context) return markManualReview(strapi, operation, bundle, "SNAPPAY_STATUS_NOT_FOUND", "SnappPay reports no transaction for this token");
      return handleCancelLocalNotFound(strapi, operation, bundle, context);
    case "REVERT_REGISTERED_AGED":
      if (!context) {
        return scheduleOperationRetry(
          strapi,
          operation,
          bundle,
          reconciliationDelay(Number(operation.retryCount || 0)),
          "SnappPay token is still registered",
        );
      }
      return handleRevertRegisteredAged(strapi, operation, bundle, token, context);
    case "LATE_SUCCESS_REVERT":
    case "LATE_SUCCESS_REVIEW":
      if (!context) {
        return parkOperationOnly(
          strapi,
          operation,
          "SNAPPAY_LATE_SUCCESS_REVIEW",
          "Provider still holds a payment for a locally cancelled attempt",
        );
      }
      return handleLateSuccess(strapi, operation, bundle, token, context, action);
    case "OBSERVE":
      if (!context) return markOperationSucceeded(strapi, operation.id, bundle.attempt.providerStatus);
      return handleObserve(strapi, operation, bundle, context);
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
    const purpose = String(operation.metadata?.purpose || "");
    const isRecoveryRead = purpose === "confirm_not_found" || purpose === "followup";
    const carriesLateSuccess = operation.metadata?.locallyCancelled === true;

    // A run that arrived before the ladder asked for it — a result-page poll,
    // the reservation sweep's deferral tick, a bare-GET return — is put back to
    // its scheduled time without calling the provider. It must not count as one
    // of the two confirming reads, because a customer refreshing the result page
    // would otherwise manufacture the confirmation that releases their own
    // wallet.
    //
    // Runs that carry new information are exempt: a callback (in particular the
    // `OK` that rescued 56 settled production orders) and an explicit customer
    // abandonment both have to be acted on now, not in half an hour.
    if (!operatorAction && operationRunWasPulled(operation)) {
      const carriesNewInformation =
        Boolean(operation.metadata?.callbackState) ||
        operation.metadata?.customerAbandoned === true;
      const scheduledForMs = operation.metadata?.scheduledFor
        ? new Date(operation.metadata.scheduledFor).getTime()
        : NaN;
      if (!carriesNewInformation && isRecoveryRead && Number.isFinite(scheduledForMs)) {
        await rescheduleOperationWithoutRetry(strapi, operation, {
          delayMs: scheduledForMs - Date.now(),
          jobIdSalt: "requeue",
          reason: "Pulled before the scheduled confirming read; re-queued unchanged",
          metadata: { purpose, pulledAt: null },
        });
        return { status: "skipped", reason: "pulled_before_scheduled_read" };
      }
    }

    // The replay short-circuit still ends every ordinary operation on a
    // terminal attempt. Three narrow classes pass it, and they are the ones
    // that only exist *because* the attempt is terminal: the confirming read of
    // a NOT_FOUND sequence (the sweep usually stamps the attempt `Expired` at
    // ~+31 min, just before the +30 min re-read lands — without this, shadow
    // mode would collect nothing at all), the +24h follow-up probe, and a late
    // provider success on a checkout we already cancelled. What they may do is
    // constrained by the attempt's state further down, not by the flag here.
    if (
      !operatorAction &&
      !isRecoveryRead &&
      !carriesLateSuccess &&
      LOCALLY_TERMINAL_STATUSES.includes(String(bundle.attempt.Status))
    ) {
      await markOperationSucceeded(strapi, operation.id, bundle.attempt.providerStatus);
      return { status: "completed", replayed: true };
    }
    // A settled attempt is never revisited by any of them: there is nothing to
    // reverse and everything to lose.
    if (String(bundle.attempt.Status) === "Succeeded" && !operatorAction) {
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
    const attemptAlreadyTerminal = attemptIsLocallyTerminal(bundle.attempt);
    // A recovery read on an attempt that is already over is exactly that — a
    // read. `mergeSnappayAttemptObservation` guards only `status <> 'Succeeded'`
    // and writes `provider_status` and `last_reconciled_at`, so letting it run
    // here would mutate a cancelled attempt from a path that is supposed to
    // observe. The evidence row carries everything that matters instead.
    if (!(isRecoveryRead && attemptAlreadyTerminal)) {
      await updateProviderObservation(strapi, bundle, statusResult, providerStatus);
    }
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
    // Set only by `requestSnappayCustomerAbandon`, i.e. by the owning shopper
    // saying they did not pay. It is a claim about their browser, never about
    // the provider, so the state machine consults it only for a token SnappPay
    // still reports as uncommitted.
    const customerAbandoned = operation.metadata?.customerAbandoned === true;

    const config = recoveryConfig();
    const notFoundMode = getRecoveryMode("not_found");
    const registeredMode = getRecoveryMode("registered");
    const lateSuccessMode = getRecoveryMode("late_success");
    const tokenAgeMs = snappayTokenAgeMs(bundle);
    const notFoundKind = notFoundKindFor(bundle);
    const providerCode = Number(statusResult.diagnostic.providerCode || 0);
    const locallyCancelled =
      carriesLateSuccess || (await isSystemCancelledLocally(strapi, bundle));

    // Confirmation state is read from the append-only evidence table rather
    // than from a counter on the operation row: operation rows are updated in
    // place (847 of 4,349 on production), so two workers racing the same read
    // could double-count or lose one there.
    // Computed even for an attempt that is already over: on production under
    // shadow the reservation sweep ends the attempt at about +31 minutes while
    // the confirming read is due at +30, so most shadow data points are reads
    // on an already-`Expired` attempt. Without this they would all record a
    // bare `observed` and the readiness statistics would never reach their
    // threshold. The state machine still refuses to act on a cancelled attempt.
    let notFound: SnappayNotFoundConfirmation | undefined;
    let provenance = { ok: false, reason: "not_evaluated" };
    if (providerCode === 1007 && notFoundMode !== "off") {
      provenance = snappayNotFoundProvenance(bundle, token, statusResult);
      const priorReads = await listNotFoundReads(
        strapi,
        Number(bundle.attempt.id),
        notFoundKind,
      );
      notFound = evaluateSnappayNotFound({
        provenanceOk: provenance.ok,
        // The read happening right now is part of the sequence.
        reads: [
          ...priorReads.map((read) => ({
            observedAtMs: read.observedAt ? new Date(read.observedAt).getTime() : 0,
            tokenAgeMs: Number(read.tokenAgeMs || 0),
          })),
          { observedAtMs: Date.now(), tokenAgeMs },
        ],
        tokenAgeMs,
        minTokenAgeMs:
          notFoundKind === "failed_then_not_found"
            ? config.failedNotFoundMinTokenAgeMs
            : config.notFoundMinTokenAgeMs,
        confirmDelayMs: config.notFoundConfirmDelayMs,
        resumedAtMs: snappayResumedAtMs(bundle),
        hasOkCallback: hasValidatedOkCallback(bundle),
      });
    }

    const registeredAged =
      providerStatus === "REGISTERED" &&
      !callbackState &&
      tokenAgeMs >= config.registeredRevertAfterMs &&
      (snappayResumedAtMs(bundle) === null ||
        Date.now() - (snappayResumedAtMs(bundle) as number) >= config.registeredRevertAfterMs);

    const action = decideSnappayRecovery({
      callbackState,
      customerAbandoned,
      providerStatus,
      // Only the code from the status read just performed. Falling back to
      // `operation.providerCode` let a code left behind by an earlier call (a
      // token request, say) decide the recovery action for a status read that
      // never produced one.
      providerCode: statusResult.diagnostic.providerCode,
      attemptAgeMs: attemptCreatedAt !== null ? Date.now() - attemptCreatedAt : null,
      locallyCancelled,
      notFoundMode,
      registeredMode,
      notFound,
      registeredAged,
    });

    const context: RecoveryContext = {
      notFoundKind,
      notFoundMode,
      registeredMode,
      lateSuccessMode,
      tokenAgeMs,
      statusResult,
      providerStatus,
      callbackState,
      provenance,
      locallyCancelled,
    };

    // An attempt that is already terminal is only ever *observed* by a
    // confirming read or a follow-up probe. On production under shadow the
    // reservation sweep cancels the order and stamps the attempt `Expired` at
    // about +31 minutes, while the confirming read is due at +30, so most
    // shadow data points land here: "enforce would have released this at +30;
    // the sweep did it at +31". Recording that is the whole purpose of the run.
    if (isRecoveryRead && attemptAlreadyTerminal) {
      const releasedBy = (await attemptEvidence(strapi, bundle)).some(
        (row) => row.decision === "released" && row.kind !== "local_ttl" && row.kind !== "local_ceiling",
      )
        ? "worker"
        : "sweep";
      await writeEvidence(strapi, bundle, {
        kind: purpose === "followup" ? "followup" : notFoundKind === "failed_then_not_found" ? "failed_then_not_found" : "not_found_confirmed",
        mode: notFoundMode,
        decision:
          purpose === "followup"
            ? "observed"
            : notFound?.confirmed && notFoundMode !== "enforce"
              ? "would_release"
              : "observed",
        result: statusResult,
        providerStatus,
        callbackState: callbackState ?? null,
        tokenAgeMs,
        details: {
          already_released_by: releasedBy,
          attemptStatus: String(bundle.attempt.Status),
          confirmation: notFound?.reason ?? null,
        },
      });
      // A follow-up probe that finds a live payment is a late success and has
      // to be routed, not just noted.
      if (
        purpose === "followup" &&
        (providerStatus === "PENDING" ||
          providerStatus === "VERIFY" ||
          providerStatus === "SETTLE")
      ) {
        await handleLateSuccess(
          strapi,
          operation,
          bundle,
          token,
          context,
          providerStatus === "SETTLE" ? "LATE_SUCCESS_REVIEW" : "LATE_SUCCESS_REVERT",
        );
        return { status: "completed", operationId, providerStatus, action: "LATE_SUCCESS" };
      }
      await markOperationSucceeded(strapi, operation.id, providerStatus);
      return { status: "completed", operationId, providerStatus, observedOnly: true };
    }

    if (action === "MANUAL_REVIEW") {
      const code = Number(statusResult.diagnostic.providerCode || 0);
      const reviewCode =
        code === 1048
          ? "SNAPPAY_VENTURE_MISMATCH"
          : code === 1007
            ? provenance.ok === false && provenance.reason !== "not_evaluated"
              ? "SNAPPAY_STATUS_NOT_FOUND_UNPROVEN"
              : "SNAPPAY_STATUS_NOT_FOUND"
            : "SNAPPAY_MANUAL_REVIEW";
      if (code === 1007 && notFoundMode !== "off") {
        await writeEvidence(strapi, bundle, {
          kind: notFoundKind,
          mode: notFoundMode,
          decision: "refused_unproven",
          result: statusResult,
          callbackState: callbackState ?? null,
          tokenAgeMs,
          details: { provenance: provenance.reason },
        });
      }
      await markManualReview(
        strapi,
        operation,
        bundle,
        reviewCode,
        "SnappPay provider state requires investigation, not a replacement payment",
      );
      return { status: "completed", operationId, providerStatus, action };
    }
    await executeRecoveryAction(
      strapi,
      operation,
      bundle,
      token,
      action,
      customerAbandoned && callbackState !== "FAILED"
        ? "customer_abandoned_checkout"
        : "failed_callback",
      context,
    );
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

/** How long a shadow decision is left alone before it is checked against reality. */
const SHADOW_FOLLOWUP_AFTER_MS = 24 * 60 * 60 * 1000;
let lastRecoverySummaryAt = 0;
let lastWalletAuditAt = 0;

/**
 * Hourly assertion of the wallet-hold invariants.
 *
 * Invariant 8 — `held_balance` equals the sum of a wallet's Active holds — has
 * only ever been checked by hand. So has "an Active hold belongs to an order
 * that is still paying". Both are the kind of drift that is cheap to detect
 * and very expensive to discover from a customer complaint, so they are
 * asserted on a schedule and reported; nothing is repaired automatically.
 */
async function auditWalletHolds(strapi: Strapi): Promise<void> {
  const now = Date.now();
  if (now - lastWalletAuditAt < 60 * 60 * 1000) return;
  lastWalletAuditAt = now;
  try {
    const audit = await auditWalletHoldConsistency(strapi);
    strapi.log.info(
      `wallet.holds.summary ${JSON.stringify({
        activeHolds: audit.activeHolds,
        heldIrr: audit.heldIrr,
        ageMs: audit.ageMs,
        byGateway: audit.byGateway,
      })}`,
    );
    for (const mismatch of audit.ledgerMismatches) {
      strapi.log.error(
        `wallet.ledger_mismatch ${JSON.stringify(mismatch)}`,
      );
      Sentry.captureMessage("wallet.ledger_mismatch", {
        level: "error",
        tags: { walletId: String(mismatch.walletId) },
        extra: mismatch,
      });
    }
    for (const stuck of audit.stuckHolds) {
      strapi.log.error(`wallet.hold_stuck ${JSON.stringify(stuck)}`);
      Sentry.captureMessage("wallet.hold_stuck", {
        level: "error",
        tags: { orderStatus: stuck.orderStatus },
        extra: stuck,
      });
    }
  } catch (error: any) {
    strapi.log.error("Wallet hold audit failed", {
      error: String(error?.message || error).slice(0, 300),
    });
  }
}

/**
 * Schedules the read-only probe that decides whether shadow mode was right.
 *
 * Every `would_release` / `would_revert` / `review` row is a claim that an
 * automatic decision was safe. The claim is worthless unless something later
 * asks the provider what actually happened to that token, which is what makes
 * "≥ 100 rows, zero contradicted" a prerequisite for enforcing rather than a
 * hope. The probe never executes a recovery action; it reads and records.
 */
async function scheduleShadowFollowupProbes(strapi: Strapi): Promise<void> {
  let candidates: Array<{ attemptId: number; orderId: number | null }> = [];
  try {
    candidates = await listAttemptsAwaitingFollowup(strapi, {
      olderThanMs: SHADOW_FOLLOWUP_AFTER_MS,
      limit: 25,
    });
  } catch (error: any) {
    strapi.log.error("Failed to list SnappPay shadow decisions awaiting a follow-up", {
      error: String(error?.message || error).slice(0, 300),
    });
    return;
  }
  for (const candidate of candidates) {
    try {
      const bundle = await loadAttemptBundle(strapi, { id: candidate.attemptId });
      if (!bundle) continue;
      await createOrReuseOperation(strapi, bundle, {
        type: "RECONCILE",
        idempotencyKey: `followup:${candidate.attemptId}`,
        metadata: {
          purpose: "followup",
          shadow: true,
          scheduledFor: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      strapi.log.error("Failed to schedule a SnappPay shadow follow-up probe", {
        attemptId: candidate.attemptId,
        error: String(error?.message || error).slice(0, 300),
      });
    }
  }
}

/**
 * Hourly recovery summary.
 *
 * Written as JSON inside the message rather than as logger metadata because
 * Strapi's logger drops the metadata object, so anything that has to be
 * greppable in production must live in the string itself.
 */
async function logRecoverySummary(strapi: Strapi): Promise<void> {
  const now = Date.now();
  if (now - lastRecoverySummaryAt < 60 * 60 * 1000) return;
  lastRecoverySummaryAt = now;
  try {
    const rows = await summarizeRecentEvidence(strapi, { windowMs: 24 * 60 * 60 * 1000 });
    const readiness = getRecoveryReadiness();
    strapi.log.info(
      `snappay.recovery.summary ${JSON.stringify({
        window: "24h",
        modes: {
          notFound: readiness.paths.not_found.effective,
          registered: readiness.paths.registered.effective,
          lateSuccess: readiness.paths.late_success.effective,
        },
        measuredTailMs: readiness.measuredTailMs,
        shadowWouldRelease: readiness.shadowWouldReleaseCount,
        evidence: rows,
      })}`,
    );
  } catch (error: any) {
    strapi.log.error("Failed to summarise SnappPay recovery evidence", {
      error: String(error?.message || error).slice(0, 300),
    });
  }
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
  await scheduleShadowFollowupProbes(strapi);
  await logRecoverySummary(strapi);
  await auditWalletHolds(strapi);

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
    abandonOrder: (orderId: number, reason?: string) =>
      requestSnappayCustomerAbandon(strapi, orderId, reason),
    queueAdminCancel: (input: Parameters<typeof queueSnappayAdminCancel>[1]) =>
      queueSnappayAdminCancel(strapi, input),
    queueAdminUpdate: (input: Parameters<typeof queueSnappayAdminUpdate>[1]) =>
      queueSnappayAdminUpdate(strapi, input),
    processOperation: (operationId: number) => processSnappayOperation(strapi, operationId),
    /** Throttled, fire-and-forget nudge from a storefront page view. */
    pullForHold: (attemptDbId: number) => requestSnappayStorefrontPull(strapi, attemptDbId),
    sweep: () => sweepSnappayOperations(strapi),
  };
}

export default ({ strapi }: { strapi: Strapi }) => createSnappayOrchestrator(strapi);
