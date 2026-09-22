"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMySeenStoryItems, markStoryItemSeen } from "@/services/story.service";

const LS_KEY = "story_seen_items_v2";
const LEGACY_LS_KEY = "story_seen_ids";
type SeenMap = Map<number, Set<string>>;

function readLocal(): SeenMap {
  const result: SeenMap = new Map();
  if (typeof window === "undefined") return result;
  try {
    const rows = JSON.parse(localStorage.getItem(LS_KEY) || "[]") as unknown;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (Array.isArray(row) && typeof row[0] === "number" && Array.isArray(row[1])) {
          result.set(row[0], new Set(row[1].filter((key): key is string => typeof key === "string")));
        }
      }
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_LS_KEY) || "[]") as unknown;
    if (Array.isArray(legacy)) {
      for (const id of legacy) {
        if (typeof id !== "number") continue;
        const keys = result.get(id) ?? new Set<string>();
        keys.add(`legacy:${id}`);
        result.set(id, keys);
      }
    }
  } catch {
    return result;
  }
  return result;
}

function persist(items: SeenMap) {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify([...items.entries()].map(([storyId, keys]) => [storyId, [...keys]])),
    );
  } catch {
    // Keep in-memory state when storage is unavailable.
  }
}

function addRows(base: SeenMap, rows: Array<{ storyId: number; itemKeys: string[] }>): SeenMap {
  const next = new Map([...base.entries()].map(([id, keys]) => [id, new Set(keys)]));
  for (const row of rows) {
    const keys = next.get(row.storyId) ?? new Set<string>();
    row.itemKeys.forEach((key) => keys.add(key));
    next.set(row.storyId, keys);
  }
  return next;
}

export function useStoriesSeenState(isAuthenticated: boolean) {
  const [seenItems, setSeenItems] = useState<SeenMap>(new Map());
  const reportedRef = useRef(new Set<string>());
  useEffect(() => setSeenItems(readLocal()), []);

  useEffect(() => {
    if (!isAuthenticated) return;
    void getMySeenStoryItems()
      .then((rows) => {
        setSeenItems((current) => {
          const next = addRows(current, rows);
          persist(next);
          return next;
        });
      })
      .catch(() => undefined);
  }, [isAuthenticated]);

  const markSeen = useCallback(
    async (storyId: number, itemKey = `legacy:${storyId}`) => {
      setSeenItems((current) => {
        if (current.get(storyId)?.has(itemKey)) return current;
        const next = addRows(current, [{ storyId, itemKeys: [itemKey] }]);
        persist(next);
        return next;
      });
      if (!isAuthenticated) return;
      const reportKey = `${storyId}:${itemKey}`;
      if (reportedRef.current.has(reportKey)) return;
      reportedRef.current.add(reportKey);
      try {
        await markStoryItemSeen(storyId, itemKey);
      } catch {
        reportedRef.current.delete(reportKey);
      }
    },
    [isAuthenticated],
  );

  const seenIds = useMemo(() => new Set(seenItems.keys()), [seenItems]);
  return { seenIds, seenItems, markSeen };
}
