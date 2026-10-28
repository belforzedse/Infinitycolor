import {
  prepareStoryMutation,
  StoryItemsValidationError,
} from "../lib/story-items";

function image(id: number) {
  return { id, mime: "image/webp", url: `/uploads/${id}.webp` };
}

function video(id: number) {
  return { id, mime: "video/mp4", url: `/uploads/${id}.mp4` };
}

function makeStrapi(existingStory: Record<string, unknown> | null = null) {
  const files = new Map<number, Record<string, unknown>>([
    [1, image(1)],
    [2, video(2)],
    [3, image(3)],
  ]);
  return {
    entityService: {
      findOne: jest.fn(async (uid: string, id: number) =>
        uid === "plugin::upload.file" ? files.get(id) ?? null : existingStory,
      ),
    },
  };
}

function item(index: number) {
  return {
    Key: `item-${index}`,
    MediaType: "image",
    Media: 1,
    DurationMs: 1000,
  };
}

describe("story item validation and compatibility", () => {
  test.each([
    [0, false],
    [1, true],
    [20, true],
    [21, false],
  ])("enforces the 1..20 boundary (%i)", async (count, valid) => {
    const data: Record<string, unknown> = { Items: Array.from({ length: count }, (_, index) => item(index)) };
    const promise = prepareStoryMutation(makeStrapi(), data);
    if (valid) {
      await expect(promise).resolves.toBeUndefined();
      expect(data.Items).toHaveLength(count);
    } else {
      await expect(promise).rejects.toBeInstanceOf(StoryItemsValidationError);
    }
  });

  it("rejects duplicate keys and media whose MIME disagrees with MediaType", async () => {
    await expect(prepareStoryMutation(makeStrapi(), {
      Items: [{ ...item(1), Key: "same" }, { ...item(2), Key: "same" }],
    })).rejects.toThrow("یکتا");
    await expect(prepareStoryMutation(makeStrapi(), {
      Items: [{ ...item(1), MediaType: "video", Media: 1 }],
    })).rejects.toThrow("فایل ویدیو");
  });

  it("normalizes duration, CTA copy, optional clearing and structured overlays per item", async () => {
    const data: Record<string, unknown> = {
      Items: [{
        ...item(1),
        MediaType: "video",
        Media: 2,
        Thumbnail: 3,
        DurationMs: 2500,
        CtaUrl: " /pdp/example ",
        CtaLabel: "ignored",
        Overlays: [{ id: "caption", type: "text", x: 50, y: 25, content: "  سلام  ", fontSize: 30 }],
      }],
    };
    await prepareStoryMutation(makeStrapi(), data);
    expect(data.Items).toEqual([expect.objectContaining({
      DurationMs: 2500,
      CtaUrl: "/pdp/example",
      CtaLabel: "مشاهده لینک",
      Thumbnail: 3,
      Overlays: [expect.objectContaining({ id: "caption", content: "سلام", x: 50, y: 25 })],
    })]);
    const first = (data.Items as any[])[0];
    const cleared: Record<string, unknown> = {
      Items: [{ id: first.id, Key: first.Key, MediaType: "video", Media: 2, Thumbnail: null, CtaUrl: null }],
    };
    await prepareStoryMutation(makeStrapi({ id: 9, Items: [first] }), cleared, 9);
    expect(cleared.Items).toEqual([expect.objectContaining({ Thumbnail: null, CtaUrl: null, CtaLabel: null })]);
  });

  it("preserves component ids and immutable keys while reordering or replacing media", async () => {
    const existing = {
      id: 9,
      Items: [
        { id: 101, Key: "alpha", MediaType: "image", Media: image(1), DurationMs: 1000 },
        { id: 102, Key: "beta", MediaType: "video", Media: video(2), DurationMs: 2000 },
      ],
    };
    const data: Record<string, unknown> = {
      Items: [
        { id: 102, Key: "attempted-change", MediaType: "video", Media: 2, DurationMs: 2000 },
        { id: 101, Key: "alpha", MediaType: "image", Media: 3, DurationMs: 1000 },
      ],
    };
    await prepareStoryMutation(makeStrapi(existing), data, 9);
    expect(data.Items).toEqual([
      expect.objectContaining({ id: 102, Key: "beta", Media: 2 }),
      expect.objectContaining({ id: 101, Key: "alpha", Media: 3 }),
    ]);
  });

  it("synthesizes old singular writes and mirrors the first item back", async () => {
    const data: Record<string, unknown> = {
      MediaType: "video",
      Media: 2,
      DurationMs: 3000,
      CtaUrl: "https://example.com/path",
    };
    await prepareStoryMutation(makeStrapi(), data);
    expect(data.Items).toEqual([expect.objectContaining({
      MediaType: "video",
      Media: 2,
      DurationMs: 3000,
      CtaLabel: "مشاهده لینک",
    })]);
    expect(data.Media).toBe(2);
    expect(data.CtaLabel).toBe("مشاهده لینک");
  });
});
