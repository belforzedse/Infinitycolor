import {
  BRIDGE_BODY_DIGEST_HEADER,
  BRIDGE_NONCE_HEADER,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TIMESTAMP_HEADER,
  canonicalJson,
  sha256Body,
  verifyBridgeSignature,
} from "@repo/auth-core";
import { RedisClient } from "../../..";

const CLOCK_WINDOW_SECONDS = 30;
const NONCE_TTL_SECONDS = 60;

export default () => async (ctx, next) => {
  if (process.env.BETTER_AUTH_BRIDGE_ENABLED !== "true") {
    ctx.status = 404;
    return;
  }

  const secret = process.env.AUTH_STRAPI_BRIDGE_SECRET?.trim();
  if (!secret || secret.length < 32) {
    strapi.log.error("Better Auth bridge rejected request", {
      reasonCode: "BRIDGE_NOT_CONFIGURED",
    });
    ctx.status = 503;
    ctx.body = { message: "سرویس احراز هویت در دسترس نیست", error: "BRIDGE_NOT_CONFIGURED" };
    return;
  }

  const timestamp = String(ctx.request.headers[BRIDGE_TIMESTAMP_HEADER] ?? "");
  const nonce = String(ctx.request.headers[BRIDGE_NONCE_HEADER] ?? "");
  const signature = String(ctx.request.headers[BRIDGE_SIGNATURE_HEADER] ?? "");
  const suppliedDigest = String(ctx.request.headers[BRIDGE_BODY_DIGEST_HEADER] ?? "");
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1_000);

  if (
    !/^\d{10}$/.test(timestamp) ||
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > CLOCK_WINDOW_SECONDS ||
    !/^[A-Za-z0-9_-]{24,64}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{40,64}$/.test(signature)
  ) {
    ctx.status = 401;
    ctx.body = { message: "درخواست داخلی نامعتبر است", error: "BRIDGE_AUTH_INVALID" };
    return;
  }

  const canonicalBody = canonicalJson(ctx.request.body ?? {});
  const calculatedDigest = sha256Body(canonicalBody);
  if (calculatedDigest !== suppliedDigest) {
    ctx.status = 401;
    ctx.body = { message: "درخواست داخلی نامعتبر است", error: "BRIDGE_BODY_TAMPERED" };
    return;
  }

  const valid = verifyBridgeSignature({
    secret,
    timestamp,
    nonce,
    method: ctx.request.method,
    path: ctx.request.path,
    bodyDigest: calculatedDigest,
    signature,
  });
  if (!valid) {
    ctx.status = 401;
    ctx.body = { message: "درخواست داخلی نامعتبر است", error: "BRIDGE_SIGNATURE_INVALID" };
    return;
  }

  const reserved = await (
    await RedisClient
  ).set(`auth:bridge:nonce:${nonce}`, "1", {
    EX: NONCE_TTL_SECONDS,
    NX: true,
  });
  if (reserved !== "OK") {
    ctx.status = 409;
    ctx.body = { message: "درخواست داخلی تکراری است", error: "BRIDGE_NONCE_REPLAY" };
    return;
  }

  await next();
};
