import { listStories, createStory, updateStory, getStory, normalizeStory } from "../story.service";
import { apiClient } from "@/services";

jest.mock("@/services", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));

const restStory = {
  id: 1,
  attributes: {
    Title: "استوری تست",
    Slug: "story",
    IsActive: true,
    SortOrder: 2,
    MediaType: "image",
    Media: {
      data: {
        id: 9,
        attributes: {
          url: "/uploads/cover.webp",
          mime: "image/webp",
          alternativeText: "جلد",
          width: 400,
          height: 400,
        },
      },
    },
    Thumbnail: { data: null },
    DurationMs: 5000,
    createdAt: "2026-09-09T10:00:00.000Z",
    updatedAt: "2026-09-09T10:00:00.000Z",
  },
};

describe("normalizeStory", () => {
  it("unwraps REST nested Media { data: { id, attributes } }", () => {
    const story = normalizeStory(restStory);

    expect(story.id).toBe(1);
    expect(story.Title).toBe("استوری تست");
    expect(story.Media).toEqual(
      expect.objectContaining({
        id: 9,
        url: "/uploads/cover.webp",
        mime: "image/webp",
        alternativeText: "جلد",
        width: 400,
        height: 400,
      }),
    );
    expect(story.Thumbnail).toBeUndefined();
  });

  it("unwraps a { data: { id, attributes } } story envelope", () => {
    const story = normalizeStory({ data: restStory });
    expect(story.id).toBe(1);
    expect(story.Media?.id).toBe(9);
    expect(story.Media?.url).toBe("/uploads/cover.webp");
  });

  it("reads flattened entity-service Media", () => {
    const story = normalizeStory({
      id: 2,
      Title: "فلت",
      Slug: "flat",
      IsActive: false,
      SortOrder: 1,
      MediaType: "video",
      Media: { id: 4, url: "/uploads/clip.mp4", mime: "video/mp4" },
      Thumbnail: { id: 5, url: "/uploads/thumb.webp", mime: "image/webp" },
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T11:00:00.000Z",
    });

    expect(story.Media).toEqual(
      expect.objectContaining({ id: 4, url: "/uploads/clip.mp4", mime: "video/mp4" }),
    );
    expect(story.Thumbnail).toEqual(
      expect.objectContaining({ id: 5, url: "/uploads/thumb.webp" }),
    );
  });

  it("keeps a bare numeric Media id so edit can resubmit without re-upload", () => {
    const story = normalizeStory({
      id: 3,
      Title: "شناسه",
      Slug: "id-only",
      IsActive: true,
      MediaType: "image",
      Media: 12,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
    });

    expect(story.Media).toEqual({ id: 12, url: "" });
  });

  it("treats { data: null } media as missing", () => {
    const story = normalizeStory({
      id: 4,
      Title: "خالی",
      Slug: "empty",
      IsActive: false,
      MediaType: "image",
      Media: { data: null },
      Thumbnail: { data: null },
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
    });

    expect(story.Media).toBeUndefined();
    expect(story.Thumbnail).toBeUndefined();
  });

  it("throws on invalid payloads", () => {
    expect(() => normalizeStory(null)).toThrow("Invalid story data");
    expect(() => normalizeStory("nope")).toThrow("Invalid story data");
  });
});

describe("story admin queries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("listStories populates Media and Thumbnail", async () => {
    (apiClient.get as jest.Mock).mockResolvedValue({
      data: [restStory],
      meta: { pagination: { page: 1, pageSize: 100, pageCount: 1, total: 1 } },
    });

    const result = await listStories({ page: 1, pageSize: 100, sort: "SortOrder:asc" });
    const endpoint = (apiClient.get as jest.Mock).mock.calls[0][0] as string;

    expect(endpoint.startsWith("/stories?")).toBe(true);
    expect(endpoint).toContain("populate%5BMedia%5D=true");
    expect(endpoint).toContain("populate%5BThumbnail%5D=true");
    expect(endpoint).toContain("pagination%5Bpage%5D=1");
    expect(result.data[0]?.Media?.id).toBe(9);
    expect(result.data[0]?.Media?.url).toBe("/uploads/cover.webp");
  });

  it("getStory, createStory, and updateStory request media populate", async () => {
    (apiClient.get as jest.Mock).mockResolvedValue({ data: restStory });
    (apiClient.post as jest.Mock).mockResolvedValue({ data: restStory });
    (apiClient.put as jest.Mock).mockResolvedValue({ data: restStory });

    await getStory(1);
    await createStory({ Title: "استوری تست", MediaType: "image", Media: 9, Thumbnail: null });
    await updateStory(1, { Title: "استوری تست", MediaType: "image", Media: 9, Thumbnail: null });

    const getUrl = (apiClient.get as jest.Mock).mock.calls[0][0] as string;
    const postUrl = (apiClient.post as jest.Mock).mock.calls[0][0] as string;
    const putUrl = (apiClient.put as jest.Mock).mock.calls[0][0] as string;

    for (const url of [getUrl, postUrl, putUrl]) {
      expect(url).toContain("populate%5BMedia%5D=true");
      expect(url).toContain("populate%5BThumbnail%5D=true");
    }

    expect(getUrl.startsWith("/stories/1?")).toBe(true);
    expect(postUrl.startsWith("/stories?")).toBe(true);
    expect(putUrl.startsWith("/stories/1?")).toBe(true);
  });
});
