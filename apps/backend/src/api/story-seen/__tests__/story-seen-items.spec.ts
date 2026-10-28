import { createStorySeenService } from "../services/story-seen";

function setup() {
  const rows: any[] = [];
  const story = { id: 3, Items: [{ Key: "a" }, { Key: "b" }] };
  const query = {
    findOne: jest.fn(async ({ where }: any) => rows.find((row) => row.DedupeKey === where.DedupeKey) ?? null),
    findMany: jest.fn(async () => rows),
  };
  const strapi = {
    entityService: {
      findOne: jest.fn(async () => story),
      create: jest.fn(async (_uid: string, { data }: any) => {
        const row = { id: rows.length + 1, ...data, story: { id: data.story } };
        rows.push(row);
        return row;
      }),
    },
    db: { query: jest.fn(() => query) },
  };
  return { service: createStorySeenService(strapi) as any, strapi, rows, query };
}

describe("item-level story seen service", () => {
  it("verifies membership, records each item once, and reports partial state", async () => {
    const { service } = setup();
    await expect(service.markItemSeen(9, 3, "missing")).rejects.toMatchObject({ code: "ITEM_NOT_FOUND" });
    await expect(service.markItemSeen(9, 3, "a")).resolves.toEqual({ created: true });
    await expect(service.markItemSeen(9, 3, "a")).resolves.toEqual({ created: false });
    await expect(service.getSeenItems(9)).resolves.toEqual([{ storyId: 3, itemKeys: ["a"] }]);
    await expect(service.getSeenStoryIds(9)).resolves.toEqual([3]);
  });

  it("uses the unique dedupe key as the concurrent-request boundary", async () => {
    const { service, strapi, rows } = setup();
    strapi.entityService.create.mockImplementationOnce(async (_uid: string, { data }: any) => {
      rows.push({ id: 50, ...data, story: { id: data.story } });
      throw new Error("unique constraint");
    });
    await expect(service.markItemSeen(9, 3, "b")).resolves.toEqual({ created: false });
  });

  it("keeps legacy mark semantics on the current first item", async () => {
    const { service, rows } = setup();
    await service.markSeen(9, 3);
    expect(rows[0].ItemKey).toBe("a");
  });
});
