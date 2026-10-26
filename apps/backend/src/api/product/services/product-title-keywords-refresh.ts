import type { Strapi } from "@strapi/strapi";
import { rebuildProductKeywords } from "./product-title-keywords";

interface RefreshState {
  dirty: boolean;
  running: Promise<void>;
}

const refreshStates = new WeakMap<Strapi, RefreshState>();

export function refreshProductKeywords(strapi: Strapi): Promise<void> {
  const existing = refreshStates.get(strapi);

  if (existing) {
    existing.dirty = true;
    return existing.running;
  }

  const state: RefreshState = {
    dirty: false,
    running: Promise.resolve(),
  };

  refreshStates.set(strapi, state);

  state.running = (async () => {
    do {
      state.dirty = false;

      await rebuildProductKeywords(strapi);
    } while (state.dirty);
  })().finally(() => {
    refreshStates.delete(strapi);
  });

  return state.running;
}
export async function waitForProductKeywordsRefresh(strapi: Strapi): Promise<void> {
  await refreshStates.get(strapi)?.running;
}
