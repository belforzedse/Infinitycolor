"use server";

import { updateTag } from "next/cache";

export async function revalidateHeroSliderCache() {
  updateTag("hero-slider");
}
