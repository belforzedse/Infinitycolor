import { randomUUID } from "node:crypto";

import { prepareStoryMutation } from "../../../api/story/lib/story-items";
import { ensureStoryItemsMigration } from "../../../api/story/services/story-items-migration";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

const STORY_UID = "api::story.story";
// A real storefront PDP link: percent-encoded Persian runs ~6 chars per letter.
const LONG_CTA_URL = `https://infinitycolor.co/pdp/${"%DA%A9%D9%84".repeat(30)}`;

let strapi: any;
const storyIds: number[] = [];
const fileIds: number[] = [];

async function createImage(): Promise<number> {
  const hash = `JEST_TEST__${randomUUID()}`;
  const file = await strapi.db.query("plugin::upload.file").create({
    data: {
      name: `${hash}.jpg`,
      hash,
      ext: ".jpg",
      mime: "image/jpeg",
      size: 1,
      url: `/uploads/${hash}.jpg`,
      provider: "local",
    },
  });
  fileIds.push(file.id);
  return file.id;
}

/** Mirrors the admin controller: normalize first, then the core entity-service write. */
async function createStoryLikeController(data: Record<string, unknown>) {
  await prepareStoryMutation(strapi, data);
  const story = await strapi.entityService.create(STORY_UID, { data });
  storyIds.push(story.id);
  return story;
}

async function joinRows(storyId: number) {
  return strapi.db
    .connection("stories_components")
    .where({ entity_id: storyId })
    .orderBy("order", "asc")
    .select("field", "component_type", "component_id");
}

async function loadItems(storyId: number) {
  const story = await strapi.entityService.findOne(STORY_UID, storyId, {
    populate: { Items: { populate: { Media: true } } },
  });
  return story.Items as Array<Record<string, any>>;
}

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  for (const id of storyIds) await strapi.entityService.delete(STORY_UID, id).catch(() => {});
  if (fileIds.length) {
    await strapi.db.query("plugin::upload.file").deleteMany({ where: { id: { $in: fileIds } } });
  }
  await teardownStrapi();
});

describe("story items on isolated PostgreSQL", () => {
  it("sizes both cta_url columns from the schema columnType", async () => {
    const widths = await strapi.db
      .connection("information_schema.columns")
      .whereIn("table_name", ["stories", "components_story_story_items"])
      .andWhere({ column_name: "cta_url" })
      .pluck("character_maximum_length");
    expect(widths.map(Number)).toEqual([2048, 2048]);
  });

  it("creates a multi-item story and links every item", async () => {
    const [first, second] = [await createImage(), await createImage()];
    const story = await createStoryLikeController({
      Title: "JEST_TEST__ multi-item",
      Slug: `jest-test-${randomUUID()}`,
      Items: [
        { Key: "jest-a", MediaType: "image", Media: first, CtaUrl: LONG_CTA_URL },
        { Key: "jest-b", MediaType: "image", Media: second },
      ],
    });

    expect(await joinRows(story.id)).toEqual([
      expect.objectContaining({ field: "Items", component_type: "story.story-item" }),
      expect.objectContaining({ field: "Items", component_type: "story.story-item" }),
    ]);
    const items = await loadItems(story.id);
    expect(items.map((item) => [item.Key, item.MediaType, item.Media?.id])).toEqual([
      ["jest-a", "image", first],
      ["jest-b", "image", second],
    ]);
    expect(items[0].CtaUrl).toBe(LONG_CTA_URL);

    const stored = await strapi.db.query(STORY_UID).findOne({ where: { id: story.id } });
    expect(stored).toMatchObject({ MediaType: "image", CtaUrl: LONG_CTA_URL });
  });

  it("updates items without dropping their join rows", async () => {
    const [first, second] = [await createImage(), await createImage()];
    const story = await createStoryLikeController({
      Title: "JEST_TEST__ update",
      Slug: `jest-test-${randomUUID()}`,
      Items: [{ Key: "jest-only", MediaType: "image", Media: first }],
    });
    const [existing] = await loadItems(story.id);

    const data: Record<string, unknown> = {
      Items: [
        { id: existing.id, Key: "jest-only", MediaType: "image", Media: first, DurationMs: 7000 },
        { Key: "jest-added", MediaType: "image", Media: second },
      ],
    };
    await prepareStoryMutation(strapi, data, story.id);
    await strapi.entityService.update(STORY_UID, story.id, { data });

    expect(await joinRows(story.id)).toHaveLength(2);
    const items = await loadItems(story.id);
    expect(items.map((item) => [item.Key, item.DurationMs])).toEqual([
      ["jest-only", 7000],
      ["jest-added", 5000],
    ]);
  });

  it("migrates a legacy single-media story into one linked item", async () => {
    const media = await createImage();
    const legacy = await strapi.db.query(STORY_UID).create({
      data: {
        Title: "JEST_TEST__ legacy",
        Slug: `jest-test-${randomUUID()}`,
        MediaType: "image",
        Media: media,
        DurationMs: 6000,
      },
    });
    storyIds.push(legacy.id);

    const report = await ensureStoryItemsMigration(strapi);

    expect(report.invalid).toBe(0);
    expect(report.migrated).toBeGreaterThanOrEqual(1);
    expect(await joinRows(legacy.id)).toHaveLength(1);
    const [item] = await loadItems(legacy.id);
    expect(item).toMatchObject({ MediaType: "image", DurationMs: 6000 });
    expect(item.Media?.id).toBe(media);
  });
});
