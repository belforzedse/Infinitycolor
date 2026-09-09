import { createHash } from "node:crypto";
import { triggerFrontendRevalidation } from "../../../utils/revalidate";
import {
  CATEGORY_EDITORIAL_IMPORT_SOURCE,
  sanitizeCategoryEditorial,
} from "../../product-category-content/services/category-editorial-sanitizer";
import { MigrationInputError } from "./customer-identity";

const CONTENT_UID = "api::product-category-content.product-category-content";
const CATEGORY_UID = "api::product-category.product-category";
const FILE_UID = "plugin::upload.file";
const CATEGORY_LOCK_NAMESPACE = 17347073;
const MAX_BATCH_ROWS = 200;
const MAX_AUDIO_SIZE_KIB = 64 * 1024;

type PreparedAudio = {
  id: number;
  sha256: string;
};

type CategoryEditorialHashInput = {
  sourceId: string;
  destinationSlug: string;
  title: string;
  paragraph: string;
  content: string;
  audioHash: string | null;
};

const hexSha256 = (value: unknown, code: string): string => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new MigrationInputError(code);
  return normalized;
};

const positiveId = (value: unknown, code: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new MigrationInputError(code);
  return parsed;
};

const sourceId = (value: unknown): string => {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized) || normalized === "0") {
    throw new MigrationInputError("CATEGORY_EDITORIAL_SOURCE_ID_INVALID");
  }
  return normalized;
};

const batchId = (value: unknown): string => {
  const normalized = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._:-]{7,159}$/i.test(normalized)) {
    throw new MigrationInputError("CATEGORY_EDITORIAL_BATCH_ID_INVALID");
  }
  return normalized;
};

const advisoryKey = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest().readBigInt64BE(0).toString();

export function categoryEditorialSourceHash(input: CategoryEditorialHashInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.sourceId,
        input.destinationSlug,
        input.title,
        input.paragraph,
        input.content,
        input.audioHash,
      ]),
      "utf8",
    )
    .digest("hex");
}

const relationValue = (value: any) =>
  value?.data?.attributes ? { id: value.data.id, ...value.data.attributes } : value?.data ?? value;

function parseAudio(value: any): PreparedAudio | null {
  if (value === null || value === undefined) return null;
  return {
    id: positiveId(value?.id, "CATEGORY_EDITORIAL_AUDIO_ID_INVALID"),
    sha256: hexSha256(value?.sha256, "CATEGORY_EDITORIAL_AUDIO_HASH_INVALID"),
  };
}

async function assertAudioFile(
  strapiInstance: any,
  audio: PreparedAudio,
  trx: any,
): Promise<any> {
  const file = await strapiInstance.db.query(FILE_UID).findOne({
    where: { id: audio.id },
    select: ["id", "name", "mime", "url", "size"],
    transacting: trx,
  } as any);
  if (!file) throw new MigrationInputError("CATEGORY_EDITORIAL_AUDIO_NOT_FOUND", 409);
  const expectedName = `wc-category-audio-${audio.sha256}.mp3`;
  const mime = String(file.mime || "").toLowerCase();
  const sizeKib = Number(file.size);
  if (file.name !== expectedName) {
    throw new MigrationInputError("CATEGORY_EDITORIAL_AUDIO_NAME_MISMATCH", 409);
  }
  if (mime !== "audio/mpeg" && mime !== "audio/mp3") {
    throw new MigrationInputError("CATEGORY_EDITORIAL_AUDIO_MIME_INVALID", 409);
  }
  if (!String(file.url || "").startsWith("/uploads/")) {
    throw new MigrationInputError("CATEGORY_EDITORIAL_AUDIO_NOT_LOCAL", 409);
  }
  if (!Number.isFinite(sizeKib) || sizeKib <= 0 || sizeKib > MAX_AUDIO_SIZE_KIB) {
    throw new MigrationInputError("CATEGORY_EDITORIAL_AUDIO_SIZE_INVALID", 409);
  }
  return file;
}

function normalizedCategory(row: any) {
  return relationValue(row?.product_category);
}

function normalizedAudio(row: any) {
  return relationValue(row?.Audio);
}

export async function getCategoryEditorialSnapshot(
  strapiInstance: any,
  input: any,
) {
  const page = Number(input?.page || 1);
  const pageSize = Number(input?.pageSize || 500);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new MigrationInputError("SNAPSHOT_PAGE_INVALID");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new MigrationInputError("SNAPSHOT_PAGE_SIZE_INVALID");
  }
  const categories = await strapiInstance.db.query(CATEGORY_UID).findMany({
    select: ["id", "Title", "Slug", "external_id", "external_source"],
    populate: {
      product_category_content: {
        select: [
          "id",
          "Title",
          "Paragraph",
          "Content",
          "IsPublished",
          "IsRTL",
          "ImportSource",
          "ImportBatchId",
          "ImportedSourceHash",
          "ImportedAt",
          "updatedAt",
        ],
        populate: { Audio: { select: ["id", "name", "mime", "url", "size"] } },
      },
    },
    orderBy: { id: "asc" },
    offset: (page - 1) * pageSize,
    limit: pageSize,
  } as any);
  return {
    entity: "categoryEditorial",
    page,
    pageSize,
    hasMore: categories.length === pageSize,
    rows: categories.map((category: any) => ({
      id: Number(category.id),
      title: category.Title,
      slug: category.Slug,
      externalId: category.external_id ?? null,
      externalSource: category.external_source ?? null,
      editorial: category.product_category_content
        ? {
            id: Number(category.product_category_content.id),
            title: category.product_category_content.Title,
            paragraph: category.product_category_content.Paragraph ?? "",
            content: category.product_category_content.Content ?? "",
            isPublished: category.product_category_content.IsPublished === true,
            isRtl: category.product_category_content.IsRTL !== false,
            importSource: category.product_category_content.ImportSource ?? null,
            importBatchId: category.product_category_content.ImportBatchId ?? null,
            importedSourceHash: category.product_category_content.ImportedSourceHash ?? null,
            importedAt: category.product_category_content.ImportedAt ?? null,
            updatedAt: category.product_category_content.updatedAt ?? null,
            audio: normalizedAudio(category.product_category_content)
              ? {
                  id: Number(normalizedAudio(category.product_category_content).id),
                  name: normalizedAudio(category.product_category_content).name,
                  mime: normalizedAudio(category.product_category_content).mime,
                  url: normalizedAudio(category.product_category_content).url,
                  size: normalizedAudio(category.product_category_content).size,
                }
              : null,
          }
        : null,
    })),
  };
}

export async function prepareCategoryEditorial(strapiInstance: any, body: any) {
  const expectedBatchId = batchId(body?.batchId);
  const expectedSourceId = sourceId(body?.sourceId);
  const categoryId = positiveId(body?.categoryId, "CATEGORY_EDITORIAL_CATEGORY_ID_INVALID");
  const expectedHash = hexSha256(
    body?.sourceHash,
    "CATEGORY_EDITORIAL_SOURCE_HASH_INVALID",
  );
  const audio = parseAudio(body?.audio);
  const sanitized = sanitizeCategoryEditorial(
    { ...(body?.data || {}), IsPublished: false },
    { allowTitleOnly: true },
  );

  return strapiInstance.db.transaction(async ({ trx }: { trx: any }) => {
    await trx.raw("SELECT pg_advisory_xact_lock(?)", [
      advisoryKey(`category-editorial-batch:${expectedBatchId}`),
    ]);
    await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [CATEGORY_LOCK_NAMESPACE, categoryId]);
    const category = await strapiInstance.db.query(CATEGORY_UID).findOne({
      where: { id: categoryId },
      select: ["id", "Title", "Slug", "external_id", "external_source"],
      transacting: trx,
    } as any);
    if (!category) throw new MigrationInputError("CATEGORY_EDITORIAL_CATEGORY_NOT_FOUND", 404);
    if (
      category.external_source !== "woocommerce" ||
      String(category.external_id || "") !== expectedSourceId
    ) {
      throw new MigrationInputError("CATEGORY_EDITORIAL_CATEGORY_SOURCE_MISMATCH", 409);
    }

    const existing = await strapiInstance.db.query(CONTENT_UID).findOne({
      where: { product_category: { id: categoryId } },
      select: ["id", "IsPublished", "ImportBatchId", "ImportedSourceHash"],
      transacting: trx,
    } as any);
    if (existing) {
      return {
        mode: "skipped",
        reason: "existing",
        id: Number(existing.id),
        isPublished: existing.IsPublished === true,
        importBatchId: existing.ImportBatchId ?? null,
        importedSourceHash: existing.ImportedSourceHash ?? null,
      };
    }

    if (audio) await assertAudioFile(strapiInstance, audio, trx);
    const computedHash = categoryEditorialSourceHash({
      sourceId: expectedSourceId,
      destinationSlug: String(category.Slug || ""),
      title: sanitized.Title,
      paragraph: sanitized.Paragraph,
      content: sanitized.Content,
      audioHash: audio?.sha256 ?? null,
    });
    if (computedHash !== expectedHash) {
      throw new MigrationInputError("CATEGORY_EDITORIAL_SOURCE_HASH_MISMATCH", 409);
    }

    const saved = await strapiInstance.db.query(CONTENT_UID).create({
      data: {
        ...sanitized,
        IsPublished: false,
        IsRTL: true,
        product_category: categoryId,
        ...(audio ? { Audio: audio.id } : {}),
        ImportSource: CATEGORY_EDITORIAL_IMPORT_SOURCE,
        ImportBatchId: expectedBatchId,
        ImportedSourceHash: expectedHash,
        ImportedAt: new Date().toISOString(),
      },
      transacting: trx,
    } as any);
    return {
      mode: "prepared",
      id: Number(saved.id),
      categoryId,
      sourceId: expectedSourceId,
      sourceHash: expectedHash,
      audioId: audio?.id ?? null,
      audioHash: audio?.sha256 ?? null,
    };
  });
}

type FinalizeEntry = {
  sourceId: string;
  categoryId: number;
  editorialId: number;
  sourceHash: string;
  audio: PreparedAudio | null;
};

function finalizeEntries(value: unknown): FinalizeEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH_ROWS) {
    throw new MigrationInputError("CATEGORY_EDITORIAL_FINALIZE_ENTRIES_INVALID");
  }
  const entries = value.map((row: any) => ({
    sourceId: sourceId(row?.sourceId),
    categoryId: positiveId(row?.categoryId, "CATEGORY_EDITORIAL_CATEGORY_ID_INVALID"),
    editorialId: positiveId(row?.editorialId, "CATEGORY_EDITORIAL_ID_INVALID"),
    sourceHash: hexSha256(row?.sourceHash, "CATEGORY_EDITORIAL_SOURCE_HASH_INVALID"),
    audio: parseAudio(row?.audio),
  }));
  for (const key of ["sourceId", "categoryId", "editorialId"] as const) {
    if (new Set(entries.map((entry) => String(entry[key]))).size !== entries.length) {
      throw new MigrationInputError("CATEGORY_EDITORIAL_FINALIZE_DUPLICATE_ENTRY");
    }
  }
  return entries.sort((left, right) => left.categoryId - right.categoryId);
}

export async function finalizeCategoryEditorial(strapiInstance: any, body: any) {
  const expectedBatchId = batchId(body?.batchId);
  const expectedEntries = finalizeEntries(body?.entries);
  const result = await strapiInstance.db.transaction(async ({ trx }: { trx: any }) => {
    await trx.raw("SELECT pg_advisory_xact_lock(?)", [
      advisoryKey(`category-editorial-batch:${expectedBatchId}`),
    ]);
    for (const entry of expectedEntries) {
      await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [
        CATEGORY_LOCK_NAMESPACE,
        entry.categoryId,
      ]);
    }
    const rows = await strapiInstance.db.query(CONTENT_UID).findMany({
      where: {
        ImportSource: CATEGORY_EDITORIAL_IMPORT_SOURCE,
        ImportBatchId: expectedBatchId,
      },
      select: [
        "id",
        "Title",
        "Paragraph",
        "Content",
        "IsPublished",
        "IsRTL",
        "ImportSource",
        "ImportBatchId",
        "ImportedSourceHash",
      ],
      populate: {
        product_category: {
          select: ["id", "Slug", "external_id", "external_source"],
        },
        Audio: { select: ["id", "name", "mime", "url", "size"] },
      },
      limit: MAX_BATCH_ROWS + 1,
      transacting: trx,
    } as any);
    if (rows.length !== expectedEntries.length) {
      throw new MigrationInputError("CATEGORY_EDITORIAL_BATCH_ROW_COUNT_MISMATCH", 409);
    }
    const byId = new Map<number, any>(
      rows.map((row: any): [number, any] => [Number(row.id), row]),
    );
    const slugs: string[] = [];
    for (const entry of expectedEntries) {
      const row = byId.get(entry.editorialId);
      if (!row) throw new MigrationInputError("CATEGORY_EDITORIAL_BATCH_ID_MISMATCH", 409);
      const category = normalizedCategory(row);
      const rowAudio = normalizedAudio(row);
      if (
        Number(category?.id) !== entry.categoryId ||
        category?.external_source !== "woocommerce" ||
        String(category?.external_id || "") !== entry.sourceId ||
        row.ImportedSourceHash !== entry.sourceHash
      ) {
        throw new MigrationInputError("CATEGORY_EDITORIAL_BATCH_RELATION_MISMATCH", 409);
      }
      if (entry.audio) {
        if (Number(rowAudio?.id) !== entry.audio.id) {
          throw new MigrationInputError("CATEGORY_EDITORIAL_AUDIO_RELATION_MISMATCH", 409);
        }
        await assertAudioFile(strapiInstance, entry.audio, trx);
      } else if (rowAudio) {
        throw new MigrationInputError("CATEGORY_EDITORIAL_AUDIO_RELATION_MISMATCH", 409);
      }
      const sanitized = sanitizeCategoryEditorial(
        {
          Title: row.Title,
          Paragraph: row.Paragraph,
          Content: row.Content,
          IsPublished: true,
          IsRTL: row.IsRTL,
        },
        { allowTitleOnly: true },
      );
      const currentHash = categoryEditorialSourceHash({
        sourceId: entry.sourceId,
        destinationSlug: String(category.Slug || ""),
        title: sanitized.Title,
        paragraph: sanitized.Paragraph,
        content: sanitized.Content,
        audioHash: entry.audio?.sha256 ?? null,
      });
      if (currentHash !== entry.sourceHash) {
        throw new MigrationInputError("CATEGORY_EDITORIAL_BATCH_CONTENT_MISMATCH", 409);
      }
      slugs.push(String(category.Slug || ""));
    }

    const published = rows.filter((row: any) => row.IsPublished === true).length;
    if (published > 0 && published !== rows.length) {
      throw new MigrationInputError("CATEGORY_EDITORIAL_BATCH_PUBLICATION_MIXED", 409);
    }
    if (published === rows.length) {
      return { mode: "unchanged", published, slugs };
    }
    for (const row of rows) {
      await strapiInstance.db.query(CONTENT_UID).update({
        where: { id: row.id },
        data: { IsPublished: true },
        transacting: trx,
      } as any);
    }
    return { mode: "published", published: rows.length, slugs };
  });

  let revalidationFailures = 0;
  if (result.mode === "published") {
    for (const slug of result.slugs) {
      const revalidation = await triggerFrontendRevalidation(
        { type: "category-editorial", slug },
        "Category Editorial Import",
      );
      revalidationFailures += revalidation.failed;
    }
  }
  return { ...result, revalidationFailures };
}
