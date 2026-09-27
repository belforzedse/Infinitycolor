import type { Strapi } from "@strapi/strapi";
import { factories } from "@strapi/strapi";
import { createHash, randomUUID } from "node:crypto";

import { canonicalCustomerPhone, normalizeCustomerPhoneDigits } from "../../../utils/customerPhoneIdentity";
import { writeAuditEvent } from "../../../audit/writer";
import { resolveUserFullName } from "../../../utils/userDisplayName";
import type { AdminActor } from "../../../utils/adminAuthorization";
import {
  extractUploadFile,
  toUploadDescriptor,
  validateIncomingPhoto,
  type IncomingUploadFile,
  ModelApplicationPhotoError,
  MODEL_APPLICATION_PHOTO_ALT_TEXTS,
} from "../lib/photos";

const TABLE = "model_applications";
const UID = "api::model-application.model-application" as const;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ALLOWED_CREATE_KEYS = new Set([
  "submissionId",
  "fullName",
  "phone",
  "email",
  "age",
  "heightCm",
  "city",
  "experience",
  "sourcePath",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = ["new", "in_review", "contacted"] as const;
const PHONEISH_PATTERN = /^[+\d۰-۹٠-٩\s().-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ModelApplicationStatus = (typeof STATUSES)[number];

export class ModelApplicationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ModelApplicationError";
  }
}

export type CreateModelApplicationInput = {
  submissionId: string;
  fullName: string;
  phone: string;
  email: string | null;
  age: number;
  heightCm: number | null;
  city: string | null;
  experience: string | null;
  sourcePath: string | null;
};

export type ModelApplicationPhoto = {
  url: string;
  name: string;
};

export type ModelApplicationSummary = {
  applicationId: string;
  fullName: string;
  phone: string;
  email: string | null;
  age: number;
  city: string | null;
  status: ModelApplicationStatus;
  submittedAt: string;
  updatedAt: string;
  version: number;
};

export type ModelApplicationDetail = ModelApplicationSummary & {
  heightCm: number | null;
  experience: string | null;
  sourcePath: string | null;
  reporterUserId: number | null;
  photoOne: ModelApplicationPhoto | null;
  photoTwo: ModelApplicationPhoto | null;
};

export type ModelApplicationQuery = {
  cursor?: string;
  limit?: number;
  status?: ModelApplicationStatus;
  search?: string;
  from?: string;
  to?: string;
};

type Cursor = { createdAt: string; id: number };

type KnexRow = Record<string, unknown>;

function text(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value == null || value === "") {
    if (required) {
      throw new ModelApplicationError("MODEL_APPLICATION_REQUIRED", 400, "این فیلد الزامی است.", {
        field,
      });
    }
    return null;
  }
  if (typeof value !== "string") {
    throw new ModelApplicationError("MODEL_APPLICATION_INVALID", 400, "اطلاعات درخواست کامل نیست.", {
      field,
    });
  }
  const normalized = value.trim();
  if (!normalized) {
    if (required) {
      throw new ModelApplicationError("MODEL_APPLICATION_REQUIRED", 400, "این فیلد الزامی است.", {
        field,
      });
    }
    return null;
  }
  if ([...normalized].length > max) {
    throw new ModelApplicationError(
      "MODEL_APPLICATION_TOO_LONG",
      400,
      "متن واردشده بیش از حد طولانی است.",
      { field, max },
    );
  }
  return normalized;
}

function sourcePath(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new ModelApplicationError("MODEL_APPLICATION_SOURCE_INVALID", 400, "صفحه مبدأ نامعتبر است.", {
      field: "sourcePath",
    });
  }
  return value;
}

function integerField(
  value: unknown,
  field: string,
  min: number,
  max: number,
  required: boolean,
): number | null {
  if (value == null || value === "") {
    if (required) {
      throw new ModelApplicationError("MODEL_APPLICATION_REQUIRED", 400, "این فیلد الزامی است.", {
        field,
      });
    }
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ModelApplicationError("MODEL_APPLICATION_INVALID", 400, "مقدار واردشده معتبر نیست.", {
      field,
    });
  }
  return parsed;
}

export function validateCreateModelApplicationPayload(body: unknown): CreateModelApplicationInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ModelApplicationError("MODEL_APPLICATION_INVALID", 400, "درخواست نامعتبر است.");
  }
  const record = body as Record<string, unknown>;
  const unexpected = Object.keys(record).filter(
    (key) => !ALLOWED_CREATE_KEYS.has(key) && key !== "photoOne" && key !== "photoTwo",
  );
  if (unexpected.length > 0) {
    throw new ModelApplicationError(
      "MODEL_APPLICATION_UNEXPECTED_FIELD",
      400,
      "درخواست شامل فیلد ناشناخته است.",
    );
  }
  const submissionId = String(record.submissionId || "").toLowerCase();
  if (!UUID_PATTERN.test(submissionId)) {
    throw new ModelApplicationError(
      "MODEL_APPLICATION_SUBMISSION_ID_INVALID",
      400,
      "شناسه ارسال نامعتبر است.",
    );
  }
  if (typeof record.phone !== "string" || record.phone.length > 64) {
    throw new ModelApplicationError("MODEL_APPLICATION_PHONE_INVALID", 400, "شماره تماس معتبر نیست.", {
      field: "phone",
    });
  }
  const phone = canonicalCustomerPhone(record.phone);
  if (!phone) {
    throw new ModelApplicationError("MODEL_APPLICATION_PHONE_INVALID", 400, "شماره تماس معتبر نیست.", {
      field: "phone",
    });
  }
  const emailRaw = text(record.email, "email", 120, false);
  if (emailRaw && !EMAIL_PATTERN.test(emailRaw)) {
    throw new ModelApplicationError("MODEL_APPLICATION_EMAIL_INVALID", 400, "ایمیل معتبر نیست.", {
      field: "email",
    });
  }
  return {
    submissionId,
    fullName: text(record.fullName, "fullName", 80, true) as string,
    phone,
    email: emailRaw ? emailRaw.toLowerCase() : null,
    age: integerField(record.age, "age", 15, 80, true) as number,
    heightCm: integerField(record.heightCm, "heightCm", 100, 250, false),
    city: text(record.city, "city", 80, false),
    experience: text(record.experience, "experience", 4_000, false),
    sourcePath: sourcePath(record.sourcePath),
  };
}

function payloadHash(input: CreateModelApplicationInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        age: input.age,
        heightCm: input.heightCm,
        city: input.city,
        experience: input.experience,
        sourcePath: input.sourcePath,
      }),
    )
    .digest("hex");
}

function knexOf(strapi: Strapi) {
  return strapi.db.connection as unknown as {
    (table: string): {
      select: (columns: unknown) => unknown;
      where: (...args: unknown[]) => unknown;
      first: (...args: unknown[]) => Promise<KnexRow | undefined>;
      insert: (row: Record<string, unknown>) => unknown;
      update: (row: Record<string, unknown>) => unknown;
      orderBy: (column: string, direction: string) => unknown;
      limit: (value: number) => unknown;
    };
    transaction: <T>(fn: (trx: unknown) => Promise<T>) => Promise<T>;
  };
}

function mapSummary(row: KnexRow): ModelApplicationSummary {
  return {
    applicationId: String(row.public_id),
    fullName: String(row.full_name),
    phone: String(row.phone),
    email: row.email == null ? null : String(row.email),
    age: Number(row.age),
    city: row.city == null ? null : String(row.city),
    status: row.status as ModelApplicationStatus,
    submittedAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    version: Number(row.version),
  };
}

function mapPhoto(value: unknown): ModelApplicationPhoto | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = record.attributes;
  const source =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>) : record;
  const url = typeof source.url === "string" ? source.url : null;
  if (!url) return null;
  return {
    url,
    name: typeof source.name === "string" ? source.name : "تصویر",
  };
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value?: string): Cursor | null {
  if (!value) return null;
  if (value.length > 512) {
    throw new ModelApplicationError("MODEL_APPLICATION_CURSOR_INVALID", 400, "نشانگر صفحه نامعتبر است.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    const createdAt = new Date(String(parsed?.createdAt));
    const id = Number(parsed?.id);
    if (Number.isNaN(createdAt.getTime()) || !Number.isSafeInteger(id) || id <= 0) throw new Error();
    return { createdAt: createdAt.toISOString(), id };
  } catch {
    throw new ModelApplicationError("MODEL_APPLICATION_CURSOR_INVALID", 400, "نشانگر صفحه نامعتبر است.");
  }
}

function queryDate(value: unknown, field: string): Date | null {
  if (!value) return null;
  if (typeof value !== "string") {
    throw new ModelApplicationError("MODEL_APPLICATION_FILTER_INVALID", 400, "فیلتر تاریخ نامعتبر است.", {
      field,
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ModelApplicationError("MODEL_APPLICATION_FILTER_INVALID", 400, "فیلتر تاریخ نامعتبر است.", {
      field,
    });
  }
  return date;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function phonePrefix(value: string): string | null {
  const normalized = normalizeCustomerPhoneDigits(value);
  let digits = normalized.replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = digits.slice(4);
  else if (digits.startsWith("98")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (!digits.startsWith("9") || digits.length > 10) return null;
  return `+98${digits}`;
}

type FilterableQuery = {
  where: (...args: unknown[]) => FilterableQuery;
  whereILike: (column: string, value: string) => FilterableQuery;
};

function applyFilters(query: FilterableQuery, filters: ModelApplicationQuery): FilterableQuery {
  if (filters.status) {
    if (!STATUSES.includes(filters.status)) {
      throw new ModelApplicationError("MODEL_APPLICATION_FILTER_INVALID", 400, "وضعیت نامعتبر است.");
    }
    query.where("status", filters.status);
  }
  const from = queryDate(filters.from, "from");
  const to = queryDate(filters.to, "to");
  if (from) query.where("created_at", ">=", from);
  if (to) query.where("created_at", "<=", to);
  if (from && to && from > to) {
    throw new ModelApplicationError("MODEL_APPLICATION_FILTER_INVALID", 400, "بازه تاریخ نامعتبر است.");
  }

  const search = typeof filters.search === "string" ? filters.search.trim() : "";
  if (search.length > 120) {
    throw new ModelApplicationError(
      "MODEL_APPLICATION_SEARCH_TOO_LONG",
      400,
      "عبارت جست‌وجو بیش از حد طولانی است.",
    );
  }
  if (search) {
    if (UUID_PATTERN.test(search)) query.where("public_id", search.toLowerCase());
    else if (PHONEISH_PATTERN.test(search)) {
      const prefix = phonePrefix(search);
      if (!prefix) {
        throw new ModelApplicationError(
          "MODEL_APPLICATION_SEARCH_INVALID",
          400,
          "شماره جست‌وجو نامعتبر است.",
        );
      }
      query.where("phone", "like", `${escapeLike(prefix)}%`);
    } else {
      const pattern = `%${escapeLike(search)}%`;
      (query as unknown as { whereRaw: (sql: string, bindings: string[]) => unknown }).whereRaw(
        "(full_name ILIKE ? OR COALESCE(city, '') ILIKE ?)",
        [pattern, pattern],
      );
    }
  }
  return query;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  if (record.code === "23505") return true;
  return typeof record.message === "string" && /unique/i.test(record.message);
}

async function uploadPhoto(
  strapi: Strapi,
  file: IncomingUploadFile,
  field: "photoOne" | "photoTwo",
): Promise<number> {
  await validateIncomingPhoto(file, field);
  const uploadService = strapi.plugin("upload").service("upload") as {
    upload: (payload: { data: Record<string, unknown>; files: unknown }) => Promise<unknown>;
  };
  const uploaded = await uploadService.upload({
    data: {
      fileInfo: {
        name: file.originalFilename.slice(0, 120),
        alternativeText: MODEL_APPLICATION_PHOTO_ALT_TEXTS[field],
      },
    },
    files: toUploadDescriptor(file),
  });
  const first = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  const id =
    first && typeof first === "object" && "id" in first ? Number((first as { id: unknown }).id) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ModelApplicationError(
      "MODEL_APPLICATION_PHOTO_FAILED",
      500,
      "آپلود تصویر انجام نشد. دوباره تلاش کنید.",
      { field },
    );
  }
  return id;
}

async function removeUploaded(strapi: Strapi, ids: number[]) {
  if (ids.length === 0) return;
  const uploadService = strapi.plugin("upload").service("upload") as {
    remove: (file: unknown) => Promise<unknown>;
  };
  for (const mediaId of ids) {
    try {
      const file = await strapi.entityService.findOne("plugin::upload.file", mediaId);
      if (file) await uploadService.remove(file);
    } catch (error) {
      strapi.log.error("Failed to delete model application upload", { mediaId, error });
    }
  }
}

export function extractRequestPhotos(files: unknown, body: unknown): {
  photoOne: IncomingUploadFile | null;
  photoTwo: IncomingUploadFile | null;
} {
  const fileRecord = files && typeof files === "object" ? (files as Record<string, unknown>) : {};
  const bodyRecord = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    photoOne: extractUploadFile(fileRecord.photoOne ?? fileRecord.photo1 ?? bodyRecord.photoOne),
    photoTwo: extractUploadFile(fileRecord.photoTwo ?? fileRecord.photo2 ?? bodyRecord.photoTwo),
  };
}

export async function createModelApplication(
  strapi: Strapi,
  input: CreateModelApplicationInput,
  photos: { photoOne: IncomingUploadFile | null; photoTwo: IncomingUploadFile | null },
  metadata: {
    reporterUserId?: number | null;
    userAgent?: string | null;
  },
) {
  const hash = payloadHash(input);
  const knex = knexOf(strapi);
  const existing = (await (knex(TABLE) as unknown as {
    where: (row: Record<string, unknown>) => { first: (columns: string[]) => Promise<KnexRow | undefined> };
  })
    .where({ submission_id: input.submissionId })
    .first(["public_id", "created_at", "payload_hash"])) as KnexRow | undefined;
  if (existing) {
    if (String(existing.payload_hash) !== hash) {
      throw new ModelApplicationError(
        "MODEL_APPLICATION_SUBMISSION_ID_REUSED",
        409,
        "این ارسال با اطلاعات دیگری ثبت شده است. دوباره ارسال کنید.",
      );
    }
    return {
      applicationId: String(existing.public_id),
      createdAt: new Date(String(existing.created_at)).toISOString(),
      replayed: true,
    };
  }

  const uploadedIds: number[] = [];
  try {
    const photoOneId = photos.photoOne
      ? await uploadPhoto(strapi, photos.photoOne, "photoOne")
      : null;
    if (photoOneId) uploadedIds.push(photoOneId);
    const photoTwoId = photos.photoTwo
      ? await uploadPhoto(strapi, photos.photoTwo, "photoTwo")
      : null;
    if (photoTwoId) uploadedIds.push(photoTwoId);

    const publicId = randomUUID();
    const created = (await strapi.entityService.create(UID, {
      data: {
        publicId,
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        age: input.age,
        heightCm: input.heightCm,
        city: input.city,
        experience: input.experience,
        photoOne: photoOneId,
        photoTwo: photoTwoId,
        status: "new",
        submissionId: input.submissionId,
        payloadHash: hash,
        reporterUserId: metadata.reporterUserId || null,
        userAgent: metadata.userAgent?.slice(0, 512) || null,
        sourcePath: input.sourcePath,
        version: 1,
      },
    })) as { publicId?: string; createdAt?: string };
    return {
      applicationId: created.publicId || publicId,
      createdAt: created.createdAt
        ? new Date(created.createdAt).toISOString()
        : new Date().toISOString(),
      replayed: false,
    };
  } catch (error) {
    await removeUploaded(strapi, uploadedIds);
    if (isUniqueViolation(error)) {
      const replayed = (await (knex(TABLE) as unknown as {
        where: (row: Record<string, unknown>) => {
          first: (columns: string[]) => Promise<KnexRow | undefined>;
        };
      })
        .where({ submission_id: input.submissionId })
        .first(["public_id", "created_at", "payload_hash"])) as KnexRow | undefined;
      if (replayed && String(replayed.payload_hash) === hash) {
        return {
          applicationId: String(replayed.public_id),
          createdAt: new Date(String(replayed.created_at)).toISOString(),
          replayed: true,
        };
      }
      throw new ModelApplicationError(
        "MODEL_APPLICATION_SUBMISSION_ID_REUSED",
        409,
        "این ارسال با اطلاعات دیگری ثبت شده است. دوباره ارسال کنید.",
      );
    }
    throw error;
  }
}

export async function queryModelApplications(strapi: Strapi, filters: ModelApplicationQuery) {
  const knex = knexOf(strapi);
  const limit = Math.min(Math.max(Number(filters.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = decodeCursor(filters.cursor);
  const base = knex(TABLE) as unknown as FilterableQuery & {
    select: (columns: string[]) => FilterableQuery & {
      orderBy: (column: string, direction: string) => {
        orderBy: (column: string, direction: string) => {
          limit: (value: number) => Promise<KnexRow[]>;
        };
      };
    };
    where: (...args: unknown[]) => FilterableQuery;
  };
  let query = applyFilters(
    base.select([
      "id",
      "public_id",
      "full_name",
      "phone",
      "email",
      "age",
      "city",
      "status",
      "version",
      "created_at",
      "updated_at",
    ]) as unknown as FilterableQuery,
    filters,
  );
  if (cursor) {
    (query as unknown as { whereRaw: (sql: string, bindings: unknown[]) => unknown }).whereRaw(
      "(created_at, id) < (?, ?)",
      [cursor.createdAt, cursor.id],
    );
  }
  const rows = (await (
    query as unknown as {
      orderBy: (column: string, direction: string) => {
        orderBy: (column: string, direction: string) => {
          limit: (value: number) => Promise<KnexRow[]>;
        };
      };
    }
  )
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1)) as KnexRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(mapSummary),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            createdAt: new Date(String(last.created_at)).toISOString(),
            id: Number(last.id),
          })
        : null,
  };
}

export async function findModelApplication(strapi: Strapi, applicationId: string) {
  if (!UUID_PATTERN.test(applicationId)) {
    throw new ModelApplicationError("MODEL_APPLICATION_ID_INVALID", 400, "شناسه درخواست نامعتبر است.");
  }
  const rows = (await strapi.entityService.findMany(UID, {
    filters: { publicId: applicationId.toLowerCase() },
    populate: { photoOne: true, photoTwo: true },
    limit: 1,
  })) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) return null;
  return {
    applicationId: String(row.publicId),
    fullName: String(row.fullName),
    phone: String(row.phone),
    email: row.email == null ? null : String(row.email),
    age: Number(row.age),
    city: row.city == null ? null : String(row.city),
    status: row.status as ModelApplicationStatus,
    submittedAt: new Date(String(row.createdAt)).toISOString(),
    updatedAt: new Date(String(row.updatedAt)).toISOString(),
    version: Number(row.version),
    heightCm: row.heightCm == null ? null : Number(row.heightCm),
    experience: row.experience == null ? null : String(row.experience),
    sourcePath: row.sourcePath == null ? null : String(row.sourcePath),
    reporterUserId: row.reporterUserId == null ? null : Number(row.reporterUserId),
    photoOne: mapPhoto(row.photoOne),
    photoTwo: mapPhoto(row.photoTwo),
  } satisfies ModelApplicationDetail;
}

export async function updateModelApplicationStatus(
  strapi: Strapi,
  applicationId: string,
  status: ModelApplicationStatus,
  expectedVersion: number,
  actor: AdminActor,
) {
  if (!UUID_PATTERN.test(applicationId)) {
    throw new ModelApplicationError("MODEL_APPLICATION_ID_INVALID", 400, "شناسه درخواست نامعتبر است.");
  }
  if (!STATUSES.includes(status)) {
    throw new ModelApplicationError("MODEL_APPLICATION_STATUS_INVALID", 400, "وضعیت نامعتبر است.");
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new ModelApplicationError("MODEL_APPLICATION_VERSION_INVALID", 400, "نسخه درخواست نامعتبر است.");
  }
  const knex = knexOf(strapi);
  return knex.transaction(async (trxUnknown) => {
    const trx = trxUnknown as {
      (table: string): {
        where: (row: Record<string, unknown>) => {
          first: (columns: string[]) => Promise<KnexRow | undefined>;
          update: (row: Record<string, unknown>) => Promise<number>;
        };
      };
    };
    const current = await trx(TABLE)
      .where({ public_id: applicationId.toLowerCase() })
      .first(["status", "version"]);
    if (!current) return { kind: "not-found" as const };
    if (Number(current.version) !== expectedVersion) {
      return {
        kind: "conflict" as const,
        current: { status: current.status, version: Number(current.version) },
      };
    }
    if (current.status !== status) {
      const updated = await trx(TABLE)
        .where({ public_id: applicationId.toLowerCase(), version: expectedVersion })
        .update({ status, version: expectedVersion + 1, updated_at: new Date() });
      if (!updated) {
        const latest = await trx(TABLE)
          .where({ public_id: applicationId.toLowerCase() })
          .first(["status", "version"]);
        return {
          kind: "conflict" as const,
          current: { status: latest?.status, version: Number(latest?.version) },
        };
      }
      const actorName =
        resolveUserFullName(actor.user) ||
        actor.user.email ||
        actor.user.username ||
        `User ${actor.user.id}`;
      await writeAuditEvent(
        strapi,
        {
          eventKey: "model_applications.status_changed",
          initiator: { type: "human", id: actor.user.id, label: actorName, role: actor.role },
          actor: { type: "human", id: actor.user.id, label: actorName, role: actor.role },
          origin: "admin_ui",
          target: { type: "model_application", id: applicationId },
          changes: [{ field: "status", from: current.status, to: status }],
          dedupeKey: `model-application-status:${applicationId}:${expectedVersion}:${status}`,
        },
        { trx: trxUnknown },
      );
    }
    const data = await findModelApplication(strapi, applicationId);
    if (!data) return { kind: "not-found" as const };
    return { kind: "success" as const, data };
  });
}

export const __modelApplicationInternals = {
  TABLE,
  STATUSES,
  encodeCursor,
  decodeCursor,
  phonePrefix,
  payloadHash,
};

export { ModelApplicationPhotoError };

export default factories.createCoreService(UID);
