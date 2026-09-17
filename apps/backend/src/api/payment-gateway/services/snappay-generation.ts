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
  const status = String(attempt.providerStatus || "").trim().toUpperCase();
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
  const status = String(input.providerStatus || "").trim().toUpperCase();
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
  const previousGeneration = state.generation
    ? { ...state.generation }
    : state.previousGeneration;
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
  const attemptAmount = Number(attempt.Amount);
  if (Number.isFinite(statusAmount) && statusAmount > 0 && Number.isFinite(attemptAmount)) {
    if (statusAmount !== attemptAmount) {
      return { ok: false, reason: "amount" };
    }
  }
  return { ok: true };
}
