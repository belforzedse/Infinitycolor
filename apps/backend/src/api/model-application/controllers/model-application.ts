import * as Sentry from "@sentry/node";

import { requireCapability } from "../../../utils/adminAuthorization";
import { consumeModelApplicationRateLimit } from "../services/rate-limit";
import {
  createModelApplication,
  extractRequestPhotos,
  findModelApplication,
  ModelApplicationError,
  queryModelApplications,
  updateModelApplicationStatus,
  validateCreateModelApplicationPayload,
  type ModelApplicationQuery,
  type ModelApplicationStatus,
} from "../services/model-application";
import { ModelApplicationPhotoError } from "../lib/photos";

const ADMIN_FILTER_KEYS = new Set(["cursor", "limit", "status", "search", "from", "to"]);

type KoaCtx = {
  is: (type: string) => boolean;
  status: number;
  body: unknown;
  query: Record<string, unknown>;
  params?: Record<string, string>;
  request: { body?: unknown; files?: unknown };
  req: { socket?: { remoteAddress?: string } };
  state?: { user?: { id?: unknown } };
  set: (name: string, value: string) => void;
  get: (name: string) => string;
    forbidden: (message?: string) => unknown;
    unauthorized: (message?: string) => unknown;
    notFound: (message?: string) => unknown;
};

function applicationError(ctx: KoaCtx, error: unknown, operation: string) {
  if (error instanceof ModelApplicationError || error instanceof ModelApplicationPhotoError) {
    const retryAfter = Number(error.details?.retryAfterSeconds);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      ctx.set("Retry-After", String(Math.ceil(retryAfter)));
    }
    ctx.status = error.status;
    ctx.body = {
      error: {
        status: error.status,
        name: error.name,
        message: error.message,
        details: { data: { errorCode: error.code, ...(error.details || {}) } },
      },
    };
    return;
  }

  const databaseCode =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  const internalCode = error instanceof Error ? error.message : "";
  const temporarilyUnavailable =
    databaseCode.startsWith("08") ||
    ["57014", "53300", "57P01", "57P03", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"].includes(
      databaseCode,
    ) ||
    internalCode.startsWith("MODEL_APPLICATION_RATE_") ||
    internalCode === "MODEL_APPLICATION_SOURCE_UNAVAILABLE";
  Sentry.captureException(
    new Error(`Model application ${operation} failed: ${databaseCode || "UNEXPECTED"}`),
    {
      tags: { operation, databaseCode: databaseCode || "none" },
    },
  );
  strapi.log.error("Model application operation failed", {
    operation,
    reasonCode: databaseCode || (error instanceof Error ? error.name : "UNKNOWN"),
  });
  ctx.status = temporarilyUnavailable ? 503 : 500;
  ctx.body = {
    error: {
      status: ctx.status,
      name: temporarilyUnavailable ? "ServiceUnavailableError" : "ApplicationError",
      message: temporarilyUnavailable
        ? "ثبت درخواست موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید."
        : "خطایی رخ داد. دوباره تلاش کنید.",
      details: {
        data: {
          errorCode: temporarilyUnavailable
            ? "MODEL_APPLICATION_UNAVAILABLE"
            : "MODEL_APPLICATION_FAILED",
        },
      },
    },
  };
}

function parseFilters(raw: unknown): ModelApplicationQuery {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModelApplicationError("MODEL_APPLICATION_FILTER_INVALID", 400, "فیلترها نامعتبر است.");
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ADMIN_FILTER_KEYS.has(key))) {
    throw new ModelApplicationError("MODEL_APPLICATION_FILTER_INVALID", 400, "فیلتر ناشناخته است.");
  }
  return {
    cursor: typeof record.cursor === "string" ? record.cursor : undefined,
    limit: record.limit == null ? undefined : Number(record.limit),
    status: typeof record.status === "string" ? (record.status as ModelApplicationStatus) : undefined,
    search: typeof record.search === "string" ? record.search : undefined,
    from: typeof record.from === "string" ? record.from : undefined,
    to: typeof record.to === "string" ? record.to : undefined,
  };
}

export default {
  async create(ctx: KoaCtx) {
    try {
      if (!ctx.is("multipart") && !ctx.is("multipart/form-data")) {
        throw new ModelApplicationError(
          "MODEL_APPLICATION_CONTENT_TYPE",
          415,
          "درخواست باید با قالب فرم ارسال شود.",
        );
      }
      let rate;
      try {
        rate = await consumeModelApplicationRateLimit(ctx);
      } catch {
        throw new ModelApplicationError(
          "MODEL_APPLICATION_RATE_UNAVAILABLE",
          503,
          "ثبت درخواست موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.",
          { retryAfterSeconds: 10 },
        );
      }
      if (rate.allowed === false) {
        throw new ModelApplicationError(
          "MODEL_APPLICATION_RATE_LIMITED",
          429,
          "تعداد ارسال‌ها زیاد است. کمی بعد دوباره تلاش کنید.",
          { retryAfterSeconds: rate.retryAfterSeconds },
        );
      }
      const body = ctx.request.body || {};
      const input = validateCreateModelApplicationPayload(body);
      const photos = extractRequestPhotos(ctx.request.files, body);
      const userId = Number(ctx.state?.user?.id);
      const result = await createModelApplication(strapi, input, photos, {
        reporterUserId: Number.isSafeInteger(userId) && userId > 0 ? userId : null,
        userAgent: String(ctx.get("user-agent") || "").slice(0, 512) || null,
      });
      ctx.status = result.replayed ? 200 : 201;
      ctx.set("Cache-Control", "no-store");
      ctx.body = { data: result };
    } catch (error) {
      applicationError(ctx, error, "create");
    }
  },

  async query(ctx: KoaCtx) {
    if (!(await requireCapability(ctx, strapi, "system.modelApplications.manage"))) return;
    try {
      ctx.set("Cache-Control", "no-store");
      const { _cb, ...filters } = ctx.query || {};
      ctx.body = { data: await queryModelApplications(strapi, parseFilters(filters)) };
    } catch (error) {
      applicationError(ctx, error, "query");
    }
  },

  async findOne(ctx: KoaCtx) {
    if (!(await requireCapability(ctx, strapi, "system.modelApplications.manage"))) return;
    try {
      const application = await findModelApplication(
        strapi,
        String(ctx.params?.applicationId || ""),
      );
      if (!application) return ctx.notFound("درخواست یافت نشد");
      ctx.set("Cache-Control", "no-store");
      ctx.body = { data: application };
    } catch (error) {
      applicationError(ctx, error, "findOne");
    }
  },

  async updateStatus(ctx: KoaCtx) {
    const actor = await requireCapability(ctx, strapi, "system.modelApplications.manage");
    if (!actor) return;
    try {
      const body = ctx.request.body || {};
      if (
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body as Record<string, unknown>).some(
          (key) => !["status", "expectedVersion"].includes(key),
        )
      ) {
        throw new ModelApplicationError(
          "MODEL_APPLICATION_STATUS_INVALID",
          400,
          "درخواست تغییر وضعیت نامعتبر است.",
        );
      }
      const payload = body as { status?: ModelApplicationStatus; expectedVersion?: unknown };
      const result = await updateModelApplicationStatus(
        strapi,
        String(ctx.params?.applicationId || ""),
        payload.status as ModelApplicationStatus,
        Number(payload.expectedVersion),
        actor,
      );
      if (result.kind === "not-found") return ctx.notFound("درخواست یافت نشد");
      if (result.kind === "conflict") {
        ctx.status = 409;
        ctx.body = {
          error: {
            status: 409,
            message: "وضعیت درخواست تغییر کرده است.",
            details: { data: { errorCode: "MODEL_APPLICATION_CONFLICT", ...result.current } },
          },
        };
        return;
      }
      ctx.body = { data: result.data };
    } catch (error) {
      applicationError(ctx, error, "updateStatus");
    }
  },
};
