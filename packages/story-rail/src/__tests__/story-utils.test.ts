import {
  firstUnseenItemIndex,
  getStoryRailPreview,
  isStoryFullySeen,
} from "../story-utils";
import type { StoryRailStory } from "../types";

const story: StoryRailStory = {
  id: 5,
  Title: "group",
  MediaType: "image",
  DurationMs: 5000,
  Thumbnail: { url: "/rail.webp", mime: "image/webp" },
  Items: [
    { Key: "a", MediaType: "video", Media: { url: "/a.mp4", mime: "video/mp4" }, Thumbnail: { url: "/poster.webp" }, DurationMs: 1000 },
    { Key: "b", MediaType: "image", Media: { url: "/b.webp", mime: "image/webp" }, DurationMs: 1000 },
    { Key: "c", MediaType: "image", Media: { url: "/c.webp", mime: "image/webp" }, DurationMs: 1000 },
  ],
};

describe("multi-item story state", () => {
  it("resumes at the first unseen item and treats reordering as key-stable", () => {
    const seen = new Map([[5, new Set(["a", "c"])]]);
    expect(firstUnseenItemIndex(story, seen)).toBe(1);
    expect(firstUnseenItemIndex({ ...story, Items: [story.Items![2], story.Items![0], story.Items![1]] }, seen)).toBe(2);
  });

  it("requires all current keys, while deletion removes an item from completion", () => {
    const seen = new Map([[5, new Set(["a", "b"])]]);
    expect(isStoryFullySeen(story, seen)).toBe(false);
    expect(isStoryFullySeen({ ...story, Items: story.Items!.slice(0, 2) }, seen)).toBe(true);
    expect(firstUnseenItemIndex({ ...story, Items: story.Items!.slice(0, 2) }, seen)).toBe(0);
  });

  it("chooses rail cover before item poster and image media", () => {
    expect(getStoryRailPreview(story, (url) => `cdn:${url}`)).toEqual({ mode: "image", url: "cdn:/rail.webp" });
    expect(getStoryRailPreview({ ...story, Thumbnail: undefined }, (url) => `cdn:${url}`)).toEqual({ mode: "image", url: "cdn:/poster.webp" });
    expect(getStoryRailPreview({ ...story, Thumbnail: undefined, Items: story.Items!.map((item) => ({ ...item, Thumbnail: undefined })) }, (url) => `cdn:${url}`)).toEqual({ mode: "image", url: "cdn:/b.webp" });
  });
});
