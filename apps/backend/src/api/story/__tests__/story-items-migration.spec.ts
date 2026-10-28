import { ensureStoryItemsMigration } from "../services/story-items-migration";

function harness() {
  const stories: any[] = [
    { id: 7, Title: "same", Slug: "wp-77-0", MediaType: "image", Media: { id: 1 }, Thumbnail: null, Items: [] },
    { id: 8, Title: "same", Slug: "wp-77-1", MediaType: "image", Media: { id: 2 }, Thumbnail: null, Items: [] },
  ];
  const seen: any[] = [
    { id: 1, story: { id: 7 }, user: { id: 40 }, SeenAt: new Date() },
    { id: 2, story: { id: 7 }, user: { id: 40 }, SeenAt: new Date() },
  ];
  const checkpoint = jest.fn();
  const strapi = {
    entityService: {
      findMany: jest.fn(async () => stories),
      update: jest.fn(async (uid: string, id: number, payload: any) => {
        const rows = uid === "api::story.story" ? stories : seen;
        const row = rows.find((entry) => entry.id === id);
        Object.assign(row, payload.data);
        return row;
      }),
      delete: jest.fn(async (_uid: string, id: number) => {
        const index = seen.findIndex((entry) => entry.id === id);
        if (index >= 0) seen.splice(index, 1);
      }),
    },
    db: { query: jest.fn(() => ({ findMany: async () => seen })) },
    store: jest.fn(() => ({ set: checkpoint })),
    log: { info: jest.fn(), warn: jest.fn() },
  };
  return { strapi, stories, seen, checkpoint };
}

describe("story item bootstrap migration", () => {
  it("migrates one row to one item, reconciles seen duplicates, and is idempotent", async () => {
    const { strapi, stories, seen, checkpoint } = harness();
    const first = await ensureStoryItemsMigration(strapi);
    expect(first).toEqual(expect.objectContaining({
      scanned: 2,
      migrated: 2,
      invalid: 0,
      verified: 2,
      seenMigrated: 1,
      seenDuplicatesRemoved: 1,
      complete: true,
    }));
    expect(stories.map((story) => story.id)).toEqual([7, 8]);
    expect(stories.map((story) => story.Slug)).toEqual(["wp-77-0", "wp-77-1"]);
    expect(stories.map((story) => story.Items[0].Key)).toEqual(["legacy:7", "legacy:8"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(expect.objectContaining({ ItemKey: "legacy:7" }));

    const second = await ensureStoryItemsMigration(strapi);
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.seenMigrated).toBe(0);
    expect(second.seenDuplicatesRemoved).toBe(0);
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });
});
