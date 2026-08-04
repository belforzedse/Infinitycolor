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

export function unsealFlowState(
  value: string | null | undefined,
): AuthFlowState | null {
  if (!value || value.length > 4_096) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) return null;
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
    if (
      state.version !== 1 ||
      typeof state.expiresAt !== "number" ||
      state.expiresAt <= Math.floor(Date.now() / 1_000) ||
      typeof state.returnTo !== "string"
    ) {
      return null;
    }
    return state as AuthFlowState;
  } catch {
    return null;
  }
}

export function readFlowState(ctx: CookieContext): AuthFlowState | null {
  return unsealFlowState(ctx.getCookie(flowCookieName()));
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

export function returnTargetFromHeaders(headers?: Headers): string {
  const env = getAuthEnv();
  let requested: string | null = null;
  const referer = headers?.get("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.origin === env.betterAuthUrl)
        requested = url.searchParams.get("returnTo");
    } catch {
      requested = null;
    }
  }
  return resolveReturnTarget(
    requested,
    env.trustedStorefrontOrigins,
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
