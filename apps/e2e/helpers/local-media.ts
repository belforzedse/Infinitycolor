import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";

const LOCAL_MEDIA_ORIGIN = "https://media.infinitycolor.test";
const fixturePath = fileURLToPath(
  new URL(
    "../../frontend/public/images/HeroSlider/ActionBannerLeft/Slide1.webp",
    import.meta.url,
  ),
);
const fixture = readFile(fixturePath);

async function fulfillMedia(route: Route) {
  await route.fulfill({
    status: 200,
    contentType: "image/webp",
    body: await fixture,
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export async function installLocalMediaFixture(page: Page) {
  await page.context().route("**/_next/image?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const source = requestUrl.searchParams.get("url");
    if (source?.startsWith(`${LOCAL_MEDIA_ORIGIN}/uploads/`)) {
      await fulfillMedia(route);
      return;
    }
    await route.continue();
  });
  await page.context().route(`${LOCAL_MEDIA_ORIGIN}/**`, fulfillMedia);
}
