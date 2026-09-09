import { factories } from "@strapi/strapi";
import { writeAuditEvent } from "../../../audit/writer";
import { triggerFrontendRevalidation } from "../../../utils/revalidate";
import {
  sanitizeCategoryEditorial,
  sanitizePublicCategoryEditorial,
  type CategoryEditorialInput,
} from "./category-editorial-sanitizer";

const UID = "api::product-category-content.product-category-content" as const;
const CATEGORY_UID = "api::product-category.product-category" as const;

function statusFor(content: any): "active" | "draft" | "none" {
  if (!content) return "none";
  return content.IsPublished ? "active" : "draft";
}

function changedFields(before: any, after: any) {
  return ["Title", "Paragraph", "Content", "IsPublished", "IsRTL"]
    .filter((field) => (before?.[field] ?? null) !== (after?.[field] ?? null))
    .map((field) => ({
      field,
      from:
        field === "Content" ? (before?.Content ? "دارای محتوا" : "خالی") : before?.[field] ?? null,
      to: field === "Content" ? (after?.Content ? "دارای محتوا" : "خالی") : after?.[field] ?? null,
    }));
}

function editableAudio(content: any) {
  const audio = content?.Audio?.data?.attributes
    ? { id: content.Audio.data.id, ...content.Audio.data.attributes }
    : content?.Audio?.data ?? content?.Audio;
  if (!audio?.id || typeof audio.url !== "string" || typeof audio.mime !== "string") return null;
  return {
    id: Number(audio.id),
    url: audio.url,
    name: String(audio.name || ""),
    mime: audio.mime,
  };
}

export default factories.createCoreService(UID, ({ strapi }) => ({
  async listTargets(params: { page: number; pageSize: number; q: string }) {
    const filters = params.q
      ? { $or: [{ Title: { $containsi: params.q } }, { Slug: { $containsi: params.q } }] }
      : {};
    const [categories, total] = await Promise.all([
      strapi.entityService.findMany(CATEGORY_UID, {
        filters,
        fields: ["Title", "Slug", "updatedAt"],
        populate: { product_category_content: { fields: ["IsPublished", "updatedAt"] } },
        sort: [{ Title: "asc" }, { id: "asc" }],
        start: (params.page - 1) * params.pageSize,
        limit: params.pageSize,
      }),
      strapi.entityService.count(CATEGORY_UID, { filters }),
    ]);
    return {
      data: (categories as any[]).map((category) => ({
        id: Number(category.id),
        title: category.Title,
        slug: category.Slug,
        status: statusFor(category.product_category_content),
        updatedAt: category.product_category_content?.updatedAt ?? null,
      })),
      meta: {
        pagination: {
          page: params.page,
          pageSize: params.pageSize,
          pageCount: Math.ceil(total / params.pageSize),
          total,
        },
      },
    };
  },

  async getEditable(categoryId: number) {
    const category = await strapi.entityService.findOne(CATEGORY_UID, categoryId, {
      fields: ["Title", "Slug"],
      populate: {
        product_category_content: {
          fields: ["Title", "Paragraph", "Content", "IsPublished", "IsRTL", "updatedAt"],
          populate: { Audio: { fields: ["url", "name", "mime"] } },
        },
      },
    });
    if (!category) return null;
    const content = (category as any).product_category_content;
    return {
      category: {
        id: Number((category as any).id),
        title: (category as any).Title,
        slug: (category as any).Slug,
      },
      editorial: content
        ? {
            id: Number(content.id),
            title: content.Title ?? "",
            paragraph: content.Paragraph ?? "",
            content: content.Content ?? "",
            isPublished: content.IsPublished === true,
            isRtl: content.IsRTL !== false,
            audio: editableAudio(content),
            updatedAt: content.updatedAt ?? null,
          }
        : null,
    };
  },

  async upsert(categoryId: number, input: CategoryEditorialInput, expectedUpdatedAt: unknown) {
    const data = sanitizeCategoryEditorial(input);
    const category = await strapi.entityService.findOne(CATEGORY_UID, categoryId, {
      fields: ["Title", "Slug"],
    });
    if (!category) return { kind: "not-found" as const };

    const saved = await strapi.db.transaction(async ({ trx }) => {
      // Serialize edits per category so two writers cannot both pass the same
      // expectedUpdatedAt check before either commits.
      await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [17347073, categoryId]);
      const existing = await strapi.db.query(UID).findOne({
        where: { product_category: { id: categoryId } },
        select: ["id", "Title", "Paragraph", "Content", "IsPublished", "IsRTL", "updatedAt"],
        transacting: trx,
      } as any);
      const actualUpdatedAt = existing?.updatedAt
        ? new Date(existing.updatedAt).toISOString()
        : null;
      if (
        existing &&
        (!expectedUpdatedAt ||
          new Date(String(expectedUpdatedAt)).toISOString() !== actualUpdatedAt)
      ) {
        return { kind: "conflict" as const };
      }
      if (!existing && expectedUpdatedAt) return { kind: "conflict" as const };

      const entity = existing
        ? await strapi.entityService.update(UID, existing.id, { data, transacting: trx })
        : await strapi.entityService.create(UID, {
            data: { ...data, product_category: categoryId },
            transacting: trx,
          });
      const changes = changedFields(existing, entity);
      await writeAuditEvent(
        strapi,
        {
          eventKey: "content.changed",
          result: changes.length ? "success" : "no_op",
          target: {
            type: "category_editorial",
            id: entity.id,
            label: String((category as any).Title),
          },
          related: { type: "category", id: categoryId, label: String((category as any).Title) },
          changes,
          metadata: {
            categoryId,
            categorySlug: (category as any).Slug,
            publicationTransition: `${existing?.IsPublished === true ? "published" : "draft"}->${
              data.IsPublished ? "published" : "draft"
            }`,
            changedFields: changes.map((change) => change.field),
          },
          summaryFa: `محتوای دسته «${String((category as any).Title)}» ذخیره شد`,
          summaryEn: `Category editorial content for “${String(
            (category as any).Title,
          )}” was saved`,
        },
        { trx },
      );
      return { kind: "saved" as const };
    });

    if (saved.kind !== "saved") {
      return { ...saved, current: await this.getEditable(categoryId) };
    }
    const revalidation = await triggerFrontendRevalidation(
      { type: "category-editorial", slug: (category as any).Slug },
      "Category Editorial",
    );
    return {
      kind: "saved" as const,
      data: await this.getEditable(categoryId),
      revalidationFailed: revalidation.failed > 0,
    };
  },

  async getPublicBySlug(slug: string) {
    const categories = await strapi.entityService.findMany(CATEGORY_UID, {
      filters: { Slug: slug },
      fields: ["Slug"],
      populate: {
        product_category_content: {
          fields: [
            "Title",
            "Paragraph",
            "Content",
            "IsPublished",
            "IsRTL",
            "ImportSource",
            "updatedAt",
          ],
          populate: { Audio: { fields: ["url", "name", "mime"] } },
        },
      },
      limit: 1,
    });
    const content = (categories as any[])?.[0]?.product_category_content;
    return sanitizePublicCategoryEditorial(content);
  },
}));
