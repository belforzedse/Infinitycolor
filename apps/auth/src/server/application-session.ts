import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { getAuthEnv } from "./env";

const APPLICATION_SESSION_AAD = Buffer.from(
  "infinity-application-session-v1",
  "utf8",
);

export interface ApplicationSessionState {
  version: 1;
  sessionToken: string;
  audience: string;
  expiresAt: number;
}

function encryptionKey(): Buffer {
  return createHash("sha256")
    .update(getAuthEnv().flowSecret, "utf8")
    .digest();
}

function trustedAudience(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return getAuthEnv().trustedApplicationOrigins.includes(origin)
      ? origin
      : null;
  } catch {
    return null;
  }
}

/**
 * Seal the central session token for a single first-party application origin.
 * The application can present this opaque value for short-lived API JWTs, but
 * cannot recover or alter the underlying Better Auth session token.
 */
export function sealApplicationSession({
  sessionToken,
  audience,
  expiresAt,
}: Omit<ApplicationSessionState, "version">): string {
  const exactAudience = trustedAudience(audience);
  const now = Math.floor(Date.now() / 1_000);
  if (
    !exactAudience ||
    !sessionToken ||
    sessionToken.length > 512 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now
  ) {
    throw new Error("Cannot seal an invalid application session");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(APPLICATION_SESSION_AAD);
  const plaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      sessionToken,
      audience: exactAudience,
      expiresAt,
    } satisfies ApplicationSessionState),
    "utf8",
  );
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}

export function unsealApplicationSession(
  value: string | null | undefined,
  audience: string,
): ApplicationSessionState | null {
  const exactAudience = trustedAudience(audience);
  if (!value || value.length > 4_096 || !exactAudience) return null;

  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      raw.subarray(0, 12),
    );
    decipher.setAAD(APPLICATION_SESSION_AAD);
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]);
    const state = JSON.parse(
      plaintext.toString("utf8"),
    ) as Partial<ApplicationSessionState>;
    if (
      state.version !== 1 ||
      typeof state.sessionToken !== "string" ||
      !state.sessionToken ||
      state.sessionToken.length > 512 ||
      state.audience !== exactAudience ||
      typeof state.expiresAt !== "number" ||
      !Number.isSafeInteger(state.expiresAt) ||
      state.expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      return null;
    }
    return state as ApplicationSessionState;
  } catch {
    return null;
  }
}
