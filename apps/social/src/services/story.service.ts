/**
 * Story API — same endpoints and normalization as storefront `story.service.ts`.
 */
import {
  getStrapiServerUrl,
  normalizeStoryEntity,
  type StorySeenItems,
} from "@repo/api";
import type { CreateStoryData, Story, StoryListParams, UpdateStoryData } from "@/types/story";
import { apiClient } from "@/lib/api-client";
import { ENDPOINTS } from "@/lib/api-endpoints";

function normalizeStory(raw: unknown): Story {
  return normalizeStoryEntity(raw);
}

function populatedStoryEndpoint(path: string): string {
  const query = new URLSearchParams();
  query.set("populate[Media]", "true");
  query.set("populate[Thumbnail]", "true");
  query.set("populate[Items][populate][Media]", "true");
  query.set("populate[Items][populate][Thumbnail]", "true");
  return `${path}?${query.toString()}`;
}

interface StrapiListResponse<T> {
  data: T[];
  meta?: {
    pagination?: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}

function getStorySortTimestamp(story: Story): number {
  const value = story.updatedAt || story.createdAt;
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortStoriesNewestFirst(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => {
    const timestampDiff = getStorySortTimestamp(b) - getStorySortTimestamp(a);
    if (timestampDiff !== 0) return timestampDiff;
    return b.id - a.id;
  });
}

export async function getActiveStories(): Promise<Story[]> {
  const baseUrl = getStrapiServerUrl();
  const url = `${baseUrl}${ENDPOINTS.STORIES.ACTIVE}`;

  const res = await fetch(url, {
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch active stories: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { data?: unknown[] };
  const items = Array.isArray(json.data) ? json.data : [];
  return sortStoriesNewestFirst(items.map(normalizeStory));
}

export async function getMySeenStoryIds(): Promise<number[]> {
  const res = await apiClient.get<number[]>(ENDPOINTS.STORIES.SEEN_MINE);
  return res.data ?? [];
}

export async function markStorySeen(storyId: number): Promise<{ created: boolean }> {
  const res = await apiClient.post<{ success: boolean; created: boolean }>(
    ENDPOINTS.STORIES.SEEN_MARK,
    { storyId },
  );
  return { created: res.data?.created ?? false };
}

export async function getMySeenStoryItems(): Promise<StorySeenItems[]> {
  const res = await apiClient.get<StorySeenItems[]>(ENDPOINTS.STORIES.SEEN_ITEMS_MINE);
  return res.data ?? [];
}

export async function markStoryItemSeen(
  storyId: number,
  itemKey: string,
): Promise<{ created: boolean }> {
  const res = await apiClient.post<{ success: boolean; created: boolean }>(
    ENDPOINTS.STORIES.SEEN_ITEM_MARK,
    { storyId, itemKey },
  );
  return { created: res.data?.created ?? false };
}

export async function listStories(params: StoryListParams = {}): Promise<StrapiListResponse<Story>> {
  const query = new URLSearchParams();
  if (params.page) query.set("pagination[page]", String(params.page));
  if (params.pageSize) query.set("pagination[pageSize]", String(params.pageSize));
  if (params.sort) query.set("sort", params.sort);
  query.set("populate[Media]", "true");
  query.set("populate[Thumbnail]", "true");
  query.set("populate[Items][populate][Media]", "true");
  query.set("populate[Items][populate][Thumbnail]", "true");
  if (typeof params.isActive === "boolean") {
    query.set("filters[IsActive][$eq]", String(params.isActive));
  }
  if (params.search) query.set("filters[Title][$containsi]", params.search);

  const suffix = query.toString();
  const endpoint = suffix ? `${ENDPOINTS.STORIES.LIST}?${suffix}` : ENDPOINTS.STORIES.LIST;
  const res = await apiClient.get<unknown[]>(endpoint, { cache: "no-store" });
  return {
    data: (res.data ?? []).map(normalizeStory),
    meta: res.meta,
  };
}

export async function getStory(id: number): Promise<Story> {
  const res = await apiClient.get<unknown>(populatedStoryEndpoint(ENDPOINTS.STORIES.DETAIL(id)), { cache: "no-store" });
  if (res.data === undefined) throw new Error("Invalid story response");
  return normalizeStory(res.data);
}

export async function createStory(data: CreateStoryData): Promise<Story> {
  const res = await apiClient.post<unknown>(populatedStoryEndpoint(ENDPOINTS.STORIES.LIST), { data });
  if (res.data === undefined) throw new Error("Invalid story response");
  return normalizeStory(res.data);
}

export async function updateStory(id: number, data: UpdateStoryData): Promise<Story> {
  const res = await apiClient.put<unknown>(populatedStoryEndpoint(ENDPOINTS.STORIES.DETAIL(id)), { data });
  if (res.data === undefined) throw new Error("Invalid story response");
  return normalizeStory(res.data);
}

export async function deleteStory(id: number): Promise<void> {
  await apiClient.delete(ENDPOINTS.STORIES.DETAIL(id));
}

export const StoryService = {
  getActiveStories,
  getMySeenStoryIds,
  markStorySeen,
  getMySeenStoryItems,
  markStoryItemSeen,
  listStories,
  getStory,
  createStory,
  updateStory,
  deleteStory,
};
