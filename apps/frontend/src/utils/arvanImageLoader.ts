// Required: Next serializes the loader function to the client, which it can
// only do from a Client Component (next/dist/docs .../next-config-js/images.md).
"use client";

import type { ImageLoaderProps } from "next/image";
import { buildEdgeImageUrl } from "@/utils/edgeImageUrl";

/**
 * The loader named by `images.loaderFile`, covering every `<Image>` that does
 * not pass an explicit `loader` prop.
 *
 * The policy itself lives in `edgeImageUrl` because ~25 call sites pass
 * `loader={imageLoader}` explicitly — which bypasses `loaderFile` entirely — and
 * two of them render on the server, where this module's `"use client"` directive
 * would be a problem.
 */
export default function arvanImageLoader(props: ImageLoaderProps): string {
  return buildEdgeImageUrl(props);
}
