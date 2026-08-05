import { randomUUID } from "node:crypto";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { getJwtToken, type JwtOptions } from "better-auth/plugins/jwt";
import { z } from "zod";
import type { BetterAuthPlugin } from "better-auth";
import { getAuthEnv } from "./env";
import { authEvent, keyedSubjectTag } from "./event-logger";
import {
  clearFlowState,
  purposeFromHeaders,
  readFlowState,
  resolveFlowReturnTarget,
  returnTargetFromHeaders,
  writeFlowState,
} from "./flow-state";
import { IdentityRepository } from "./identity-repository";
import { ReturnGrantRepository } from "./return-grants";
import { StrapiBridgeClient, StrapiBridgeError } from "./bridge-client";

const phoneSchema = z
  .string()
  .regex(/^(?:09[0-9]{9}|\+989[0-9]{9})$/, "شماره همراه وارد شده معتبر نیست");
const otpSchema = z.string().regex(/^[0-9]{6}$/, "کد تایید باید شش رقم باشد");
const passwordSchema = z.string().min(6).max(128);

interface InfinityPluginOptions {
  bridge: StrapiBridgeClient;
  identities: IdentityRepository;
  grants: ReturnGrantRepository;
  jwtOptions: JwtOptions;
  fetchImpl?: typeof fetch;
}

function bridgeApiError(error: unknown): APIError {
  if (error instanceof StrapiBridgeError) {
    if (error.status === 401 || error.status === 403) {
      return new APIError("UNAUTHORIZED", { message: error.message });
    }
    if (error.status >= 500) {
      return new APIError("INTERNAL_SERVER_ERROR", { message: error.message });
    }
    return new APIError("BAD_REQUEST", { message: error.message });
  }
  return new APIError("INTERNAL_SERVER_ERROR", {
    message: "احراز هویت ناموفق بود. دوباره تلاش کنید.",
  });
}

function assertTrustedRequest(ctx: {
  headers?: Headers;
  context: {
    isTrustedOrigin(
      url: string,
      settings?: { allowRelativePaths: boolean },
    ): boolean;
  };
}): void {
  const origin = ctx.headers?.get("origin");
  if (
    origin &&
    !ctx.context.isTrustedOrigin(origin, { allowRelativePaths: false })
  ) {
    throw new APIError("FORBIDDEN", { message: "مبدا درخواست مجاز نیست" });
  }
  const fetchSite = ctx.headers?.get("sec-fetch-site");
  if (fetchSite === "cross-site" && !origin) {
    throw new APIError("FORBIDDEN", { message: "درخواست نامعتبر است" });
  }
}

function callbackFor(returnTo: string, grant: string): string {
  const callback = new URL("/auth/callback", new URL(returnTo).origin);
  callback.searchParams.set("grant", grant);
  return callback.toString();
}

export function infinityCredentialsPlugin(
  options: InfinityPluginOptions,
): BetterAuthPlugin {
  const completeSignIn = async (
    ctx: any,
    strapiUserId: number,
    returnTo: string,
  ) => {
    const identity =
      await options.identities.getOrCreateVerifiedIdentity(strapiUserId);
    const user = await ctx.context.internalAdapter.findUserById(
      identity.betterAuthUserId,
    );
    if (!user)
      throw new APIError("INTERNAL_SERVER_ERROR", {
        message: "اتصال هویت نامعتبر است",
      });
    const session = await ctx.context.internalAdapter.createSession(
      user.id,
      false,
    );
    await setSessionCookie(ctx, { session, user }, false);
    authEvent("session_created", { subjectTag: keyedSubjectTag(strapiUserId) });
    return { identity, session };
  };

  const createReturn = async (sessionId: string, returnTo: string) => {
    const grant = await options.grants.create(sessionId, returnTo);
    authEvent("return_grant_created", {
      subjectTag: keyedSubjectTag(sessionId),
    });
    return callbackFor(returnTo, grant);
  };

  return {
    id: "infinity-credentials",
    version: "1.0.0",
    endpoints: {
      infinityPhoneStatus: createAuthEndpoint(
        "/infinity/phone-status",
        { method: "POST", body: z.object({ phone: phoneSchema }) },
        async (ctx) => {
          assertTrustedRequest(ctx);
          try {
            const response = await options.bridge.phoneStatus(ctx.body.phone);
            const current = readFlowState(ctx);
            writeFlowState(ctx, {
              phone: ctx.body.phone,
              purpose: purposeFromHeaders(ctx.headers),
              returnTo: returnTargetFromHeaders(
                ctx.headers,
                current?.returnTo,
              ),
            });
            return ctx.json({ message: "welcome", hasUser: response.hasUser });
          } catch (error) {
            throw bridgeApiError(error);
          }
        },
      ),
      infinityOtpRequest: createAuthEndpoint(
        "/infinity/otp/request",
        { method: "POST", body: z.object({ phone: phoneSchema }) },
        async (ctx) => {
          assertTrustedRequest(ctx);
          const current = readFlowState(ctx);
          if (current?.phone && current.phone !== ctx.body.phone) {
            throw new APIError("BAD_REQUEST", {
              message: "شماره همراه با جریان جاری مطابقت ندارد",
            });
          }
          try {
            const response = await options.bridge.requestOtp(ctx.body.phone);
            writeFlowState(ctx, {
              phone: ctx.body.phone,
              challengeId: response.challengeId,
              purpose: purposeFromHeaders(ctx.headers),
              returnTo: returnTargetFromHeaders(
                ctx.headers,
                current?.returnTo,
              ),
            });
            return ctx.json({ message: "otp sent" });
          } catch (error) {
            throw bridgeApiError(error);
          }
        },
      ),
      infinityOtpVerify: createAuthEndpoint(
        "/infinity/otp/verify",
        { method: "POST", body: z.object({ otp: otpSchema }) },
        async (ctx) => {
          assertTrustedRequest(ctx);
          const flow = readFlowState(ctx);
          if (!flow?.challengeId || !flow.phone || flow.purpose === "reset") {
            throw new APIError("BAD_REQUEST", {
              message:
                "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
            });
          }
          try {
            const verified = await options.bridge.verifyOtp(
              flow.challengeId,
              ctx.body.otp,
            );
            const { session } = await completeSignIn(
              ctx,
              verified.strapiUserId,
              flow.returnTo,
            );
            if (verified.isNewUser === true) {
              return ctx.json({
                message: "login successful",
                redirectTo: "/auth/register/info",
              });
            }
            const redirectTo = await createReturn(session.id, flow.returnTo);
            return ctx.json({ message: "login successful", redirectTo });
          } catch (error) {
            throw bridgeApiError(error);
          }
        },
      ),
      infinityPasswordSignIn: createAuthEndpoint(
        "/infinity/password/sign-in",
        {
          method: "POST",
          body: z.object({ phone: phoneSchema, password: passwordSchema }),
        },
        async (ctx) => {
          assertTrustedRequest(ctx);
          const flow = readFlowState(ctx);
          if (flow?.phone && flow.phone !== ctx.body.phone) {
            throw new APIError("BAD_REQUEST", {
              message: "شماره همراه با جریان جاری مطابقت ندارد",
            });
          }
          try {
            const verified = await options.bridge.verifyPassword(
              ctx.body.phone,
              ctx.body.password,
            );
            const returnTo = returnTargetFromHeaders(
              ctx.headers,
              flow?.returnTo,
            );
            const { session } = await completeSignIn(
              ctx,
              verified.strapiUserId,
              returnTo,
            );
            const redirectTo = await createReturn(session.id, returnTo);
            return ctx.json({ message: "login successful", redirectTo });
          } catch (error) {
            throw bridgeApiError(error);
          }
        },
      ),
      infinityPasswordReset: createAuthEndpoint(
        "/infinity/password/reset",
        {
          method: "POST",
          body: z.object({ otp: otpSchema, newPassword: passwordSchema }),
        },
        async (ctx) => {
          assertTrustedRequest(ctx);
          const flow = readFlowState(ctx);
          if (!flow?.challengeId || flow.purpose !== "reset") {
            throw new APIError("BAD_REQUEST", {
              message:
                "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
            });
          }
          try {
            const verified = await options.bridge.resetPassword(
              flow.challengeId,
              ctx.body.otp,
              ctx.body.newPassword,
            );
            const identity =
              await options.identities.getOrCreateVerifiedIdentity(
                verified.strapiUserId,
              );
            await ctx.context.internalAdapter.deleteUserSessions(
              identity.betterAuthUserId,
            );
            deleteSessionCookie(ctx);
            clearFlowState(ctx);
            authEvent("sessions_revoked", {
              reasonCode: "PASSWORD_RESET",
              subjectTag: keyedSubjectTag(verified.strapiUserId),
            });
            return ctx.json({ message: "رمز عبور با موفقیت تغییر کرد." });
          } catch (error) {
            throw bridgeApiError(error);
          }
        },
      ),
      infinityRegisterInfo: createAuthEndpoint(
        "/infinity/register-info",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: z.object({
            firstName: z.string().trim().min(1).max(100),
            lastName: z.string().trim().min(1).max(100),
            password: passwordSchema,
            birthDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .nullable(),
          }),
        },
        async (ctx) => {
          assertTrustedRequest(ctx);
          const flow = readFlowState(ctx);
          const sessionState = ctx.context.session;
          if (!flow?.phone || !sessionState) throw new APIError("UNAUTHORIZED");
          const token = await getJwtToken(ctx, options.jwtOptions);
          const env = getAuthEnv();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5_000);
          try {
            const response = await (options.fetchImpl ?? fetch)(
              `${env.strapiInternalUrl}/api/auth/register-info`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json",
                  authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ ...ctx.body, phone: flow.phone }),
                cache: "no-store",
                signal: controller.signal,
              },
            );
            const body = (await response.json().catch(() => ({}))) as {
              message?: string;
            };
            if (!response.ok) {
              throw new APIError(
                response.status === 401 ? "UNAUTHORIZED" : "BAD_REQUEST",
                {
                  message:
                    body.message ?? "ثبت اطلاعات ناموفق بود. دوباره تلاش کنید.",
                },
              );
            }
            const redirectTo = await createReturn(
              sessionState.session.id,
              flow.returnTo,
            );
            clearFlowState(ctx);
            return ctx.json({
              message: body.message ?? "info updated",
              redirectTo,
            });
          } finally {
            clearTimeout(timeout);
          }
        },
      ),
      infinityReturnGrantExchange: createAuthEndpoint(
        "/infinity/return-grant/exchange",
        {
          method: "POST",
          body: z.object({ grant: z.string().min(40).max(80) }),
        },
        async (ctx) => {
          const exchanged = await options.grants.exchange(ctx.body.grant);
          if (!exchanged) {
            authEvent("return_grant_rejected", {
              reasonCode: "INVALID_OR_EXPIRED",
            });
            throw new APIError("BAD_REQUEST", {
              message: "مجوز بازگشت نامعتبر یا منقضی شده است",
            });
          }
          authEvent("return_grant_used", {
            subjectTag: keyedSubjectTag(exchanged.sessionId),
          });
          return ctx.json({
            returnTo: exchanged.returnTo,
            authenticated: true as const,
          });
        },
      ),
      infinityFlowStart: createAuthEndpoint(
        "/infinity/flow/start",
        {
          method: "POST",
          body: z.object({
            returnTo: z.string().max(2_048).nullable().optional(),
          }),
        },
        async (ctx) => {
          assertTrustedRequest(ctx);
          const current = readFlowState(ctx);
          writeFlowState(ctx, {
            phone: current?.phone,
            challengeId: current?.challengeId,
            purpose: current?.purpose ?? purposeFromHeaders(ctx.headers),
            returnTo: resolveFlowReturnTarget(
              ctx.body.returnTo,
              current?.returnTo,
            ),
          });
          return ctx.json({ phone: current?.phone ?? null });
        },
      ),
      infinityFlowInfo: createAuthEndpoint(
        "/infinity/flow",
        { method: "GET" },
        async (ctx) => {
          assertTrustedRequest(ctx);
          const flow = readFlowState(ctx);
          return ctx.json({ phone: flow?.phone ?? null });
        },
      ),
      infinityFlowClear: createAuthEndpoint(
        "/infinity/flow/clear",
        { method: "POST" },
        async (ctx) => {
          assertTrustedRequest(ctx);
          clearFlowState(ctx);
          return ctx.json({ cleared: true as const });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

export function createInfinityJwtOptions(
  identities: IdentityRepository,
): JwtOptions {
  const env = getAuthEnv();
  return {
    jwks: {
      keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
      rotationInterval: env.jwksRotationSeconds,
      gracePeriod: env.jwksGraceSeconds,
      disablePrivateKeyEncryption: false,
    },
    jwt: {
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
      expirationTime: env.jwtExpirationTime,
      async definePayload(session) {
        const identity = await identities.findByBetterAuthUserId(
          session.user.id,
        );
        if (!identity) {
          authEvent("token_rejected", { reasonCode: "UNLINKED_IDENTITY" });
          throw new APIError("UNAUTHORIZED", {
            message: "اتصال هویت یافت نشد",
          });
        }
        authEvent("token_issued", {
          subjectTag: keyedSubjectTag(identity.strapiUserId),
        });
        return {
          strapi_user_id: identity.strapiUserId,
          sid: session.session.id,
          jti: randomUUID(),
          nbf: Math.floor(Date.now() / 1_000) - 1,
        };
      },
      getSubject: (session) => session.user.id,
    },
  };
}
