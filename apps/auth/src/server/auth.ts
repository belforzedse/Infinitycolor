import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getAuthPool } from "./database";
import { getAuthEnv } from "./env";
import { StrapiBridgeClient } from "./bridge-client";
import { IdentityRepository } from "./identity-repository";
import { ReturnGrantRepository } from "./return-grants";
import {
  createInfinityJwtOptions,
  infinityCredentialsPlugin,
} from "./infinity-plugin";
import { startAuthAuditDeliveryLoop } from "./audit-outbox";

const env = getAuthEnv();
const pool = getAuthPool();
const identities = new IdentityRepository(pool);
const grants = new ReturnGrantRepository(pool);
const jwtOptions = createInfinityJwtOptions(identities);

export const auth = betterAuth({
  appName: "Infinity Color Auth",
  baseURL: env.betterAuthUrl,
  basePath: "/api/auth",
  secret: env.betterAuthSecret,
  database: pool,
  trustedOrigins: [...env.trustedApplicationOrigins],
  emailAndPassword: { enabled: false },
  user: {
    modelName: "users",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
  },
  session: {
    modelName: "sessions",
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    expiresIn: env.sessionTtlSeconds,
    disableSessionRefresh: true,
    cookieCache: { enabled: false },
  },
  account: {
    modelName: "accounts",
    fields: {
      accountId: "account_id",
      providerId: "provider_id",
      userId: "user_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    accountLinking: { enabled: false },
  },
  verification: {
    modelName: "verifications",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    storeIdentifier: "hashed",
  },
  advanced: {
    useSecureCookies: env.nodeEnv === "production",
    disableCSRFCheck: false,
    disableOriginCheck: false,
    crossSubDomainCookies: { enabled: false },
    trustedProxyHeaders: false,
    cookiePrefix: "infinity-auth",
    defaultCookieAttributes: {
      secure: env.nodeEnv === "production",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
    cookies: {
      session_token: {
        name: "infinity-auth.session_token",
        attributes: {
          secure: env.nodeEnv === "production",
          httpOnly: true,
          sameSite: "lax",
          path: "/",
        },
      },
    },
  },
  plugins: [
    infinityCredentialsPlugin({
      bridge: new StrapiBridgeClient(),
      identities,
      grants,
      jwtOptions,
      pool,
    }),
    jwt({
      ...jwtOptions,
      schema: {
        jwks: {
          modelName: "jwks",
          fields: {
            publicKey: "public_key",
            privateKey: "private_key",
            createdAt: "created_at",
            expiresAt: "expires_at",
          },
        },
      },
    }),
  ],
});

startAuthAuditDeliveryLoop(pool);

export type InfinityAuth = typeof auth;
