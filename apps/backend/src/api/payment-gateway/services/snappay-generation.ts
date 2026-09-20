import { gatewayExpectedAmountIrr } from "../../payment-attempt/services/payment-legs";

/**
 * Durable SnappPay payment-generation identity.
 *
 * Local attempt/order ids, the provider transactionId, the paymentToken, the
 * merchant generation sequence, the stock reservation, and a confirmed payment
 * are different objects. A later generation may be minted only after generation N
 * is proven terminal at the provider, and the candidate for N+1 must be persisted
 * before POST /token so a crash cannot mint N+2.
 */

export type SnappayTerminalEvidence = "REVERT" | "CANCEL";

export type SnappayGenerationRecord = {
  seq: number;
  transactionId: string;
  dispatchedAt: string;
  callbackNonceHash?: string;
  paymentTokenFingerprint?: string;
  /** Raw token kept so a late callback can still verify the retired generation. */
  paymentToken?: string;
  terminalEvidence?: SnappayTerminalEvidence;
};

export type SnappayPendingDispatch = {
  seq: number;
  transactionId: string;
  dispatchedAt: string;
  callbackNonceHash: string;
};

export type SnappayGenerationState = {
  tokenAttemptSeq: number;
  generation?: SnappayGenerationRecord;
  previousGeneration?: SnappayGenerationRecord;
  pendingDispatch?: SnappayPendingDispatch;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPositiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function asNonEmpty(value: unknown): string {
  const text = String(value || "").trim();
  return text;
}

function asTerminalEvidence(value: unknown): SnappayTerminalEvidence | undefined {
  return value === "REVERT" || value === "CANCEL" ? value : undefined;
}

function parseGenerationRecord(value: unknown): SnappayGenerationRecord | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const seq = asPositiveInt(record.seq);
  const transactionId = asNonEmpty(record.transactionId);
  const dispatchedAt = asNonEmpty(record.dispatchedAt);
  if (!seq || !transactionId || !dispatchedAt) return undefined;
  const parsed: SnappayGenerationRecord = { seq, transactionId, dispatchedAt };
  const callbackNonceHash = asNonEmpty(record.callbackNonceHash);
  if (callbackNonceHash) parsed.callbackNonceHash = callbackNonceHash;
  const paymentTokenFingerprint = asNonEmpty(record.paymentTokenFingerprint);
  if (paymentTokenFingerprint) parsed.paymentTokenFingerprint = paymentTokenFingerprint;
  const paymentToken = asNonEmpty(record.paymentToken);
  if (paymentToken) parsed.paymentToken = paymentToken;
  const terminalEvidence = asTerminalEvidence(record.terminalEvidence);
  if (terminalEvidence) parsed.terminalEvidence = terminalEvidence;
  return parsed;
}

function parsePendingDispatch(value: unknown): SnappayPendingDispatch | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const seq = asPositiveInt(record.seq);
  const transactionId = asNonEmpty(record.transactionId);
  const dispatchedAt = asNonEmpty(record.dispatchedAt);
  const callbackNonceHash = asNonEmpty(record.callbackNonceHash);
  if (!seq || !transactionId || !dispatchedAt || !callbackNonceHash) return undefined;
  return { seq, transactionId, dispatchedAt, callbackNonceHash };
}

export function readSnappayGenerationState(providerResponse: unknown): SnappayGenerationState {
  const record = asRecord(providerResponse) || {};
  const tokenAttemptSeq = asPositiveInt(record.tokenAttemptSeq);
  const generation = parseGenerationRecord(record.generation);
  const previousGeneration = parseGenerationRecord(record.previousGeneration);
  const pendingDispatch =
    parsePendingDispatch(record.pendingDispatch) ||
    (asNonEmpty(record.pendingTransactionId)
      ? parsePendingDispatch({
          seq: tokenAttemptSeq || 1,
          transactionId: record.pendingTransactionId,
          dispatchedAt: record.dispatchedAt || new Date(0).toISOString(),
          callbackNonceHash: record.callbackNonceHash || "unknown",
        })
      : undefined);
  return {
    tokenAttemptSeq,
    ...(generation ? { generation } : {}),
    ...(previousGeneration ? { previousGeneration } : {}),
    ...(pendingDispatch ? { pendingDispatch } : {}),
  };
}

export function snappayHasInFlightDispatch(providerResponse: unknown): boolean {
  const state = readSnappayGenerationState(providerResponse);
  if (!state.pendingDispatch) return false;
  const issued =
    state.generation?.seq === state.pendingDispatch.seq &&
    Boolean(state.generation.paymentTokenFingerprint);
  return !issued;
}

export function snappayDispatchWasAttempted(
  attempt: {
    providerResponse?: unknown;
    providerReference?: unknown;
  },
  trackId?: unknown,
): boolean {
  const state = readSnappayGenerationState(attempt.providerResponse);
  if (state.tokenAttemptSeq > 0) return true;
  if (state.pendingDispatch) return true;
  if (state.generation?.paymentTokenFingerprint || state.generation?.paymentToken) return true;
  const fingerprint = asNonEmpty(asRecord(attempt.providerResponse)?.tokenFingerprint);
  if (fingerprint) return true;
  return Boolean(asNonEmpty(trackId));
}

export function snappayProviderGenerationIsTerminal(attempt: {
  providerStatus?: unknown;
  providerResponse?: unknown;
}): boolean {
  const status = String(attempt.providerStatus || "")
    .trim()
    .toUpperCase();
  if (status === "REVERT" || status === "CANCEL") return true;
  const state = readSnappayGenerationState(attempt.providerResponse);
  return Boolean(state.generation?.terminalEvidence);
}

export function snappayProviderPaymentIsUnresolved(
  attempt: {
    Status?: unknown;
    providerStatus?: unknown;
    providerResponse?: unknown;
    providerReference?: unknown;
  },
  trackId?: unknown,
): boolean {
  if (String(attempt.Status || "") === "Succeeded") return false;
  if (!snappayDispatchWasAttempted(attempt, trackId)) return false;
  return !snappayProviderGenerationIsTerminal(attempt);
}

export function nextSnappayGenerationSeq(currentSeq: number): number {
  const seq = Number.isInteger(currentSeq) && currentSeq > 0 ? currentSeq : 0;
  return seq + 1;
}

export function isConsecutiveSnappayGeneration(currentSeq: number, nextSeq: number): boolean {
  return nextSeq === nextSnappayGenerationSeq(currentSeq);
}

export function activeSnappayTransactionIds(attempt: {
  providerReference?: unknown;
  providerResponse?: unknown;
}): string[] {
  const state = readSnappayGenerationState(attempt.providerResponse);
  const ids = [
    asNonEmpty(attempt.providerReference),
    state.pendingDispatch?.transactionId,
    state.generation?.transactionId,
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

export function rememberedSnappayTransactionIds(attempt: {
  providerReference?: unknown;
  providerResponse?: unknown;
}): string[] {
  const state = readSnappayGenerationState(attempt.providerResponse);
  const ids = [
    ...activeSnappayTransactionIds(attempt),
    state.previousGeneration?.transactionId,
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

export function rememberedSnappayNonceHashes(attempt: {
  callbackNonceHash?: unknown;
  providerResponse?: unknown;
}): string[] {
  const state = readSnappayGenerationState(attempt.providerResponse);
  const hashes = [
    asNonEmpty(attempt.callbackNonceHash),
    state.pendingDispatch?.callbackNonceHash,
    state.generation?.callbackNonceHash,
    state.previousGeneration?.callbackNonceHash,
  ].filter((hash): hash is string => Boolean(hash));
  return [...new Set(hashes)];
}

export function buildSnappayPendingDispatch(input: {
  seq: number;
  transactionId: string;
  callbackNonceHash: string;
  dispatchedAt?: Date;
}): SnappayPendingDispatch {
  return {
    seq: input.seq,
    transactionId: input.transactionId,
    dispatchedAt: (input.dispatchedAt || new Date()).toISOString(),
    callbackNonceHash: input.callbackNonceHash,
  };
}

export function seedSnappayGenerationFromLegacyAttempt(input: {
  providerResponse?: unknown;
  transactionId?: unknown;
  callbackNonceHash?: unknown;
  paymentToken?: unknown;
  redirectedAt?: unknown;
  providerStatus?: unknown;
}): Record<string, unknown> {
  const previous = asRecord(input.providerResponse) || {};
  const state = readSnappayGenerationState(previous);
  if (state.generation) return previous;
  const seq = state.tokenAttemptSeq || (asNonEmpty(input.paymentToken) ? 1 : 0);
  const transactionId = asNonEmpty(input.transactionId);
  if (!seq || !transactionId) return previous;
  const redirectedAt = input.redirectedAt ? new Date(String(input.redirectedAt)) : new Date();
  const generation: SnappayGenerationRecord = {
    seq,
    transactionId,
    dispatchedAt: Number.isNaN(redirectedAt.getTime())
      ? new Date().toISOString()
      : redirectedAt.toISOString(),
  };
  const callbackNonceHash = asNonEmpty(input.callbackNonceHash);
  if (callbackNonceHash) generation.callbackNonceHash = callbackNonceHash;
  const fingerprint = asNonEmpty(previous.tokenFingerprint);
  if (fingerprint) generation.paymentTokenFingerprint = fingerprint;
  const paymentToken = asNonEmpty(input.paymentToken);
  if (paymentToken) generation.paymentToken = paymentToken;
  const status = String(input.providerStatus || "")
    .trim()
    .toUpperCase();
  if (status === "REVERT" || status === "CANCEL") {
    generation.terminalEvidence = status;
  }
  return { ...previous, tokenAttemptSeq: seq, generation };
}

export function withSnappayPendingDispatch(
  providerResponse: unknown,
  pending: SnappayPendingDispatch,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const previous = asRecord(providerResponse) || {};
  const state = readSnappayGenerationState(previous);
  const previousGeneration = state.generation ? { ...state.generation } : state.previousGeneration;
  return {
    ...previous,
    ...extra,
    tokenAttemptSeq: pending.seq,
    pendingTransactionId: pending.transactionId,
    pendingDispatch: pending,
    ...(previousGeneration ? { previousGeneration } : {}),
  };
}

export function withIssuedSnappayToken(
  providerResponse: unknown,
  input: {
    seq: number;
    transactionId: string;
    callbackNonceHash: string;
    paymentTokenFingerprint: string;
    paymentToken: string;
  },
): Record<string, unknown> {
  const previous = asRecord(providerResponse) || {};
  const state = readSnappayGenerationState(previous);
  const generation: SnappayGenerationRecord = {
    seq: input.seq,
    transactionId: input.transactionId,
    dispatchedAt: state.pendingDispatch?.dispatchedAt || new Date().toISOString(),
    callbackNonceHash: input.callbackNonceHash,
    paymentTokenFingerprint: input.paymentTokenFingerprint,
    paymentToken: input.paymentToken,
  };
  const rest = { ...previous };
  delete rest.pendingDispatch;
  delete rest.pendingTransactionId;
  return {
    ...rest,
    tokenAttemptSeq: input.seq,
    pendingTransactionId: null,
    tokenFingerprint: input.paymentTokenFingerprint,
    generation,
    ...(state.previousGeneration ? { previousGeneration: state.previousGeneration } : {}),
  };
}

export function withSnappayTerminalEvidence(
  providerResponse: unknown,
  evidence: SnappayTerminalEvidence,
): Record<string, unknown> {
  const previous = asRecord(providerResponse) || {};
  const state = readSnappayGenerationState(previous);
  if (!state.generation) {
    return previous;
  }
  return {
    ...previous,
    generation: { ...state.generation, terminalEvidence: evidence },
  };
}

export function statusMatchesActiveSnappayGeneration(
  attempt: {
    Amount?: unknown;
    WalletAmount?: unknown;
    GatewayAmount?: unknown;
    providerReference?: unknown;
    providerResponse?: unknown;
  },
  status: { transactionId?: unknown; amount?: unknown },
): { ok: boolean; reason?: "transaction" | "amount" } {
  const statusTransactionId = asNonEmpty(status.transactionId);
  if (statusTransactionId) {
    const active = new Set(activeSnappayTransactionIds(attempt));
    if (!active.has(statusTransactionId)) {
      return { ok: false, reason: "transaction" };
    }
  }
  const statusAmount = Number(status.amount);
  const attemptAmount = gatewayExpectedAmountIrr(attempt);
  if (Number.isFinite(statusAmount) && statusAmount > 0 && Number.isFinite(attemptAmount)) {
    if (statusAmount !== attemptAmount) {
      return { ok: false, reason: "amount" };
    }
  }
  return { ok: true };
}

export const SNAPPAY_GENERATION_IDENTITY_KEYS = [
  "generation",
  "previousGeneration",
  "pendingDispatch",
  "pendingTransactionId",
  "tokenAttemptSeq",
  "tokenFingerprint",
] as const;

/**
 * Stored fingerprints may be the full SHA-256 or the 12-character display
 * prefix used in logs. Either form is identity evidence; mixed forms still match
 * when one is a prefix of the other.
 */
export function snappayFingerprintsAlign(stored: unknown, computed: unknown): boolean {
  const left = asNonEmpty(stored);
  const right = asNonEmpty(computed);
  if (!left || !right) return true;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

export function snappayObservationPatch(
  result: {
    successful?: boolean;
    diagnostic?: {
      endpoint?: unknown;
      httpStatus?: unknown;
      providerCode?: unknown;
      timedOut?: unknown;
      transportError?: unknown;
    };
  },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    endpoint: result.diagnostic?.endpoint,
    successful: result.successful === true,
    httpStatus: result.diagnostic?.httpStatus,
    providerCode: result.diagnostic?.providerCode,
    timedOut: result.diagnostic?.timedOut === true,
    transportError: result.diagnostic?.transportError === true,
    ...extra,
  };
  for (const key of SNAPPAY_GENERATION_IDENTITY_KEYS) {
    delete patch[key];
  }
  return patch;
}

export function snappayCallbackTargetsPreviousGeneration(
  attempt: { providerReference?: unknown; providerResponse?: unknown },
  transactionId: string,
): boolean {
  const state = readSnappayGenerationState(attempt.providerResponse);
  const tx = asNonEmpty(transactionId);
  if (!tx || !state.previousGeneration) return false;
  if (state.generation?.transactionId === tx) return false;
  if (asNonEmpty(attempt.providerReference) === tx && state.generation) return false;
  return state.previousGeneration.transactionId === tx;
}

function tomanToRial(value: unknown): number {
  const toman = Number(value);
  return Number.isFinite(toman) ? Math.round(toman * 10) : NaN;
}

/**
 * Identity + eligibility for reopening a stored paymentPageUrl after parsed
 * status 404/1007. Missing generation JSON is not permission by itself; a
 * matching current TrackId and exact stored URL can support a legacy resume
 * when no competing dispatch exists.
 */
export function snappayStoredPaymentPageResume(input: {
  paymentToken: string;
  urlToken: string;
  /** Durable TrackId. URL recovery alone is not legacy identity proof. */
  storedTrackId?: unknown;
  redirectUrl: unknown;
  orderStatus: unknown;
  reservationStatus: unknown;
  attemptStatus: unknown;
  attemptAmount: unknown;
  contractAmountToman?: unknown;
  quoteTotalToman?: unknown;
  providerReference?: unknown;
  providerResponse?: unknown;
  tokenFingerprint?: string;
  hasValidatedCallback: boolean;
}): { ok: boolean; reason?: string } {
  if (input.hasValidatedCallback) return { ok: false, reason: "callback-recovery" };
  const attemptStatus = String(input.attemptStatus || "");
  if (["Succeeded", "Cancelled", "Expired"].includes(attemptStatus)) {
    return { ok: false, reason: "attempt-not-payable" };
  }
  if (String(input.orderStatus || "") !== "Paying") {
    return { ok: false, reason: "order-not-payable" };
  }
  if (String(input.reservationStatus || "") !== "Reserved") {
    return { ok: false, reason: "reservation-not-payable" };
  }
  if (snappayHasInFlightDispatch(input.providerResponse)) {
    return { ok: false, reason: "in-flight-dispatch" };
  }
  const paymentToken = asNonEmpty(input.paymentToken);
  const urlToken = asNonEmpty(input.urlToken);
  if (!paymentToken || !urlToken || paymentToken !== urlToken) {
    return { ok: false, reason: "token-url-mismatch" };
  }
  const redirectUrl = asNonEmpty(input.redirectUrl);
  if (!redirectUrl || !/^https:\/\//i.test(redirectUrl)) {
    return { ok: false, reason: "redirect-url-invalid" };
  }
  const attemptAmount = Number(input.attemptAmount);
  if (!Number.isFinite(attemptAmount) || attemptAmount <= 0) {
    return { ok: false, reason: "amount-mismatch" };
  }
  const quoteRial = tomanToRial(input.quoteTotalToman);
  if (Number.isFinite(quoteRial) && quoteRial > 0 && quoteRial !== attemptAmount) {
    return { ok: false, reason: "amount-mismatch" };
  }
  const contractRial = tomanToRial(input.contractAmountToman);
  if (Number.isFinite(contractRial) && contractRial > 0 && contractRial !== attemptAmount) {
    return { ok: false, reason: "amount-mismatch" };
  }

  const fingerprint = asNonEmpty(input.tokenFingerprint);
  const state = readSnappayGenerationState(input.providerResponse);
  const previousToken = asNonEmpty(state.previousGeneration?.paymentToken);
  if (previousToken && previousToken === paymentToken && state.generation) {
    const currentToken = asNonEmpty(state.generation.paymentToken);
    if (currentToken && currentToken !== paymentToken) {
      return { ok: false, reason: "previous-generation" };
    }
  }
  if (
    state.previousGeneration?.transactionId &&
    asNonEmpty(input.providerReference) === state.previousGeneration.transactionId &&
    state.generation &&
    state.generation.transactionId !== state.previousGeneration.transactionId
  ) {
    return { ok: false, reason: "previous-generation" };
  }

  const record = asRecord(input.providerResponse) || {};
  const topFingerprint = asNonEmpty(record.tokenFingerprint);
  const generationFingerprint = asNonEmpty(state.generation?.paymentTokenFingerprint);
  if (fingerprint) {
    if (topFingerprint && !snappayFingerprintsAlign(topFingerprint, fingerprint)) {
      return { ok: false, reason: "fingerprint-mismatch" };
    }
    if (generationFingerprint && !snappayFingerprintsAlign(generationFingerprint, fingerprint)) {
      return { ok: false, reason: "fingerprint-mismatch" };
    }
  }
  if (state.generation) {
    if (state.generation.paymentToken && state.generation.paymentToken !== paymentToken) {
      return { ok: false, reason: "generation-token-mismatch" };
    }
    if (state.tokenAttemptSeq && state.generation.seq !== state.tokenAttemptSeq) {
      return { ok: false, reason: "seq-mismatch" };
    }
    const currentTx = asNonEmpty(input.providerReference);
    if (currentTx && state.generation.transactionId !== currentTx) {
      return { ok: false, reason: "transaction-mismatch" };
    }
  } else {
    const storedTrackId = asNonEmpty(input.storedTrackId);
    if (!storedTrackId || storedTrackId !== paymentToken || storedTrackId !== urlToken) {
      return { ok: false, reason: "identity-unproven" };
    }
  }
  return { ok: true };
}
