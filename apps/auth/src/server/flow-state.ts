import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { resolveReturnTarget } from "@repo/auth-core/redirects";
import { getAuthEnv } from "./env";

const FLOW_AAD = Buffer.from("infinity-auth-flow-v1", "utf8");
const FLOW_TTL_SECONDS = 10 * 60;

export interface AuthFlowState {
  version: 1;
  expiresAt: number;
  phone?: string;
  challengeId?: string;
  purpose?: "login" | "reset";
  returnTo: string;
}

interface CookieContext {
  headers?: Headers;
  getCookie(name: string): string | null | undefined;
  setCookie(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: "lax";
      path: string;
      maxAge: number;
    },
  ): void;
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(getAuthEnv().flowSecret, "utf8").digest();
}

function flowCookieName(): string {
  return getAuthEnv().nodeEnv === "production"
    ? "__Host-infinity-auth-flow"
    : "infinity-auth-flow";
}

export function sealFlowState(
  state: Omit<AuthFlowState, "version" | "expiresAt">,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(FLOW_AAD);
  const plaintext = Buffer.from(
    JSON.stringify({
      ...state,
      version: 1,
      expiresAt: Math.floor(Date.now() / 1_000) + FLOW_TTL_SECONDS,
    } satisfies AuthFlowState),
    "utf8",
  );
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}

/**
 * Why a sealed flow cookie was refused. Every one of these used to collapse into a
 * bare `null`, which made the Samsung Internet redirect loop undiagnosable: a cookie
 * the browser never stored and a cookie that sat idle past its 10 minutes looked
 * identical from the server.
 */
export type FlowStateRejection =
  | "absent"
  | "oversized"
  | "truncated"
  | "undecryptable"
  | "expired"
  | "malformed";

export interface FlowStateInspection {
  state: AuthFlowState | null;
  rejection: FlowStateRejection | null;
}

export function inspectFlowState(
  value: string | null | undefined,
): FlowStateInspection {
  if (!value) return { state: null, rejection: "absent" };
  if (value.length > 4_096) return { state: null, rejection: "oversized" };
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) return { state: null, rejection: "truncated" };
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      raw.subarray(0, 12),
    );
    decipher.setAAD(FLOW_AAD);
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]);
    const state = JSON.parse(
      plaintext.toString("utf8"),
    ) as Partial<AuthFlowState>;
    if (state.version !== 1 || typeof state.returnTo !== "string") {
      return { state: null, rejection: "malformed" };
    }
    if (typeof state.expiresAt !== "number") {
      return { state: null, rejection: "malformed" };
    }
    if (state.expiresAt <= Math.floor(Date.now() / 1_000)) {
      return { state: null, rejection: "expired" };
    }
    return { state: state as AuthFlowState, rejection: null };
  } catch {
    return { state: null, rejection: "undecryptable" };
  }
}

export function unsealFlowState(
  value: string | null | undefined,
): AuthFlowState | null {
  return inspectFlowState(value).state;
}

export function readFlowState(ctx: CookieContext): AuthFlowState | null {
  return unsealFlowState(ctx.getCookie(flowCookieName()));
}

/** `readFlowState` plus the reason it came back empty, for telemetry. */
export function inspectRequestFlowState(
  ctx: CookieContext,
): FlowStateInspection {
  return inspectFlowState(ctx.getCookie(flowCookieName()));
}

/** Exposed so telemetry can say whether the browser is refusing a `__Host-` cookie. */
export function flowCookieIsHostPrefixed(): boolean {
  return flowCookieName().startsWith("__Host-");
}

export function writeFlowState(
  ctx: CookieContext,
  state: Omit<AuthFlowState, "version" | "expiresAt">,
): void {
  const env = getAuthEnv();
  ctx.setCookie(flowCookieName(), sealFlowState(state), {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: FLOW_TTL_SECONDS,
  });
}

export function clearFlowState(ctx: CookieContext): void {
  const env = getAuthEnv();
  ctx.setCookie(flowCookieName(), "", {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function returnTargetFromHeaders(
  headers?: Headers,
  currentReturnTo?: string,
): string {
  let requested: string | null = null;
  const referer = headers?.get("referer");
  if (referer) {
    try {
      const env = getAuthEnv();
      const url = new URL(referer);
      if (url.origin === env.betterAuthUrl)
        requested = url.searchParams.get("returnTo");
    } catch {
      requested = null;
    }
  }
  return resolveFlowReturnTarget(requested, currentReturnTo);
}

export function resolveFlowReturnTarget(
  requested?: string | null,
  currentReturnTo?: string,
): string {
  const env = getAuthEnv();
  return resolveReturnTarget(
    requested ?? currentReturnTo,
    env.trustedApplicationOrigins,
    env.defaultStorefrontOrigin,
  );
}

export function purposeFromHeaders(headers?: Headers): "login" | "reset" {
  const referer = headers?.get("referer");
  if (!referer) return "login";
  try {
    const url = new URL(referer);
    return url.pathname.startsWith("/auth/forgot-password") ? "reset" : "login";
  } catch {
    return "login";
  }
}
