import type { Strapi } from "@strapi/strapi";
import { refreshProductKeywords } from "../api/product/services/product-title-keywords-refresh";
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function startProductKeywordsJob(strapi: Strapi) {
  let stopped = false;
  let running: Promise<void> | undefined;

  const refresh = () => {
    if (stopped || running) return;

    running = refreshProductKeywords(strapi)
      .then(() => undefined)
      .catch((error) => {
        strapi.log.error("Product keywords refresh failed", error);
      })
      .finally(() => {
        running = undefined;
      });
  };

  refresh();

  const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
