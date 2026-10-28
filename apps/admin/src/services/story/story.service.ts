/**
 * Story API service.
 * Throws English errors for logging; callers must translate before showing toasts.
 * Public methods (getActiveStories) are safe for server-side use.
 * Auth methods require a valid JWT in the request (sent automatically by apiClient).
 */
import { apiClient } from "@/services";
import { getStrapiServerUrl, ENDPOINTS } from "@/constants/api";
import { normalizeStoryEntity, normalizeStoryMediaAsset } from "@repo/api";
import type {
  Story,
  StoryListParams,
  CreateStoryData,
  UpdateStoryData,
} from "@/types/story";

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

function applyStoryMediaPopulate(query: URLSearchParams): URLSearchParams {
  query.set("populate[Media]", "true");
  query.set("populate[Thumbnail]", "true");
  query.set("populate[Items][populate][Media]", "true");
  query.set("populate[Items][populate][Thumbnail]", "true");
  return query;
}

function storyEndpoint(path: string, extra?: URLSearchParams): string {
  const query = applyStoryMediaPopulate(extra ?? new URLSearchParams());
  return `${path}?${query.toString()}`;
}

export const normalizeMediaAsset = normalizeStoryMediaAsset;

export function normalizeStory(raw: unknown): Story {
  return normalizeStoryEntity(raw);
}

// ─── Public (server + client) ────────────────────────────────────────────────

/**
 * Fetches active, in-schedule stories.
 * Safe to call from Server Components; uses internal Strapi URL at runtime.
 */
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
  return items.map(normalizeStory);
}

// ─── Authenticated (client only) ─────────────────────────────────────────────

/** Returns the list of story IDs the current user has already seen. */
export async function getMySeenStoryIds(): Promise<number[]> {
  const res = await apiClient.get<number[]>(ENDPOINTS.STORIES.SEEN_MINE);
  return res.data ?? [];
}

/**
 * Idempotent mark-seen. Safe to call multiple times for the same story.
 * Returns whether a new record was actually created.
 */
export async function markStorySeen(storyId: number): Promise<{ created: boolean }> {
  const res = await apiClient.post<{ success: boolean; created: boolean }>(
    ENDPOINTS.STORIES.SEEN_MARK,
    { storyId }
  );
  return { created: res.data?.created ?? false };
}

// ─── Admin (content.stories.manage) ──────────────────────────────────────────

export async function listStories(params: StoryListParams = {}): Promise<StrapiListResponse<Story>> {
  const query = new URLSearchParams();
  if (params.page) query.set("pagination[page]", String(params.page));
  if (params.pageSize) query.set("pagination[pageSize]", String(params.pageSize));
  if (params.sort) query.set("sort", params.sort);
  if (typeof params.isActive === "boolean") {
    query.set("filters[IsActive][$eq]", String(params.isActive));
  }
  if (params.search) query.set("filters[Title][$containsi]", params.search);

  const endpoint = storyEndpoint(ENDPOINTS.STORIES.LIST, query);
  const res = await apiClient.get<unknown[]>(endpoint, { cache: "no-store" });
  return {
    data: (res.data ?? []).map(normalizeStory),
    meta: res.meta,
  };
}

export async function getStory(id: number): Promise<Story> {
  const res = await apiClient.get<unknown>(storyEndpoint(ENDPOINTS.STORIES.DETAIL(id)), {
    cache: "no-store",
  });
  const raw = res.data;
  if (raw === undefined) throw new Error("Invalid story response");
  return normalizeStory(raw);
}

export async function createStory(data: CreateStoryData): Promise<Story> {
  const res = await apiClient.post<unknown>(storyEndpoint(ENDPOINTS.STORIES.LIST), { data });
  const raw = res.data;
  if (raw === undefined) throw new Error("Invalid story response");
  return normalizeStory(raw);
}

export async function updateStory(id: number, data: UpdateStoryData): Promise<Story> {
  const res = await apiClient.put<unknown>(storyEndpoint(ENDPOINTS.STORIES.DETAIL(id)), { data });
  const raw = res.data;
  if (raw === undefined) throw new Error("Invalid story response");
  return normalizeStory(raw);
}

export async function deleteStory(id: number): Promise<void> {
  await apiClient.delete(ENDPOINTS.STORIES.DETAIL(id));
}

export const storyService = {
  getActiveStories,
  getMySeenStoryIds,
  markStorySeen,
  listStories,
  getStory,
  createStory,
  updateStory,
  deleteStory,
};
