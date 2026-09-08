import { NextRequest, NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { timingSafeEqual } from "node:crypto";
import {
  HOME_PRODUCTS_TAG,
  PRODUCT_COLLECTION_TAG,
  PRODUCT_TAG,
  SITEMAP_TAG,
  decodeSlugOnce,
  categorySlugTag,
  productSlugTag,
} from "@/constants/cacheTags";

/** Compare secrets without leaking length/prefix information via timing. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build the PDP path Next.js stored the route under.
 *
 * Strapi sends the raw slug (Persian, possibly percent-encoded from a legacy
 * row). Passing that straight to `revalidatePath` produced a path that never
 * matched the stored key, so the call succeeded and invalidated nothing. We
 * decode once and re-encode so the segment matches Next's own encoding.
 */
export function buildPdpPath(rawPath: string): string {
  const withoutLeadingSlash = rawPath.replace(/^\/+/, "");
  const withoutPrefix = withoutLeadingSlash.replace(/^pdp\//, "");
  return `/pdp/${encodeURIComponent(decodeSlugOnce(withoutPrefix))}`;
}

export function buildCategoryPath(rawSlug: string): string {
  return `/plp/category/${encodeURIComponent(decodeSlugOnce(rawSlug.replace(/^\/+/, "")))}`;
}

/**
 * On-demand revalidation API route
 *
 * This endpoint allows Strapi to trigger Next.js cache revalidation
 * when blog posts are published, updated, or deleted.
 *
 * Usage from Strapi:
 * POST /api/revalidate
 * Headers: { "Authorization": "Bearer <secret>" }
 * Body: { "path": "/blog-post-slug", "type": "blog-post" }
 *
 * Security: Protected by REVALIDATION_SECRET token
 */
export async function POST(request: NextRequest) {
  try {
    // Verify authorization token
    const authHeader = request.headers.get("authorization");
    const secret = process.env.REVALIDATION_SECRET;

    if (!secret) {
      console.error("REVALIDATION_SECRET environment variable is not set");
      return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
    }

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid authorization header" },
        { status: 401 },
      );
    }

    const token = authHeader.replace("Bearer ", "");
    if (!secretsMatch(token, secret)) {
      return NextResponse.json({ error: "Invalid authorization token" }, { status: 403 });
    }

    // Parse request body
    const body = await request.json();
    const { path, type, tag, slug } = body;

    if (!path && !tag && !(type === "category-editorial" && slug)) {
      return NextResponse.json(
        { error: "Missing 'path' or 'tag' in request body" },
        { status: 400 },
      );
    }

    if (type === "category-editorial" && typeof slug === "string" && slug.trim()) {
      const categoryPath = buildCategoryPath(slug);
      const categoryTag = categorySlugTag(slug);
      revalidatePath(categoryPath);
      revalidateTag(categoryTag, "max");
      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        paths: [categoryPath],
        tags: [categoryTag],
      });
    }

    // Revalidate based on type
    if (type === "blog-post" && path) {
      // Ensure path starts with / (blog post routes are at /[slug], not /blog/[slug])
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;

      // Revalidate the specific blog post page
      revalidatePath(normalizedPath);
      // Also revalidate the blog listing page
      revalidatePath("/blog");
      // Revalidate sitemap
      revalidatePath("/sitemap.xml");
      revalidateTag(SITEMAP_TAG, "max");

      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        paths: [normalizedPath, "/blog", "/sitemap.xml"],
        tags: [SITEMAP_TAG],
      });
    }

    if (type === "product" && path) {
      // Tags are the primary mechanism — they are exact-match strings and so are
      // immune to the Persian-slug encoding problem that silently defeated the
      // path-only approach. Paths stay as a secondary for the rendered routes
      // that hold no tagged fetch of their own.
      const pdpPath = buildPdpPath(path);
      const slugTag = productSlugTag(path.replace(/^\/+/, "").replace(/^pdp\//, ""));

      const tags = [slugTag, PRODUCT_TAG, PRODUCT_COLLECTION_TAG, HOME_PRODUCTS_TAG, SITEMAP_TAG];
      tags.forEach((t) => revalidateTag(t, "max"));

      revalidatePath(pdpPath);
      revalidatePath("/");
      revalidatePath("/plp");
      revalidatePath("/sitemap.xml");

      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        paths: [pdpPath, "/", "/plp", "/sitemap.xml"],
        tags,
      });
    }

    if (type === "home-products") {
      revalidatePath("/");
      revalidateTag(HOME_PRODUCTS_TAG, "max");

      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        paths: ["/"],
        tags: [HOME_PRODUCTS_TAG],
      });
    }

    if (type === "blog-listing") {
      // Revalidate blog listing and sitemap
      revalidatePath("/blog");
      revalidatePath("/sitemap.xml");
      revalidateTag(SITEMAP_TAG, "max");

      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        paths: ["/blog", "/sitemap.xml"],
        tags: [SITEMAP_TAG],
      });
    }

    if (type === "hero-slider") {
      // Left as an immediate-expiry CacheLifeConfig rather than the "max" profile
      // the other branches use: this is a working, unrelated feature and the two
      // forms are not equivalent.
      revalidateTag("hero-slider", { expire: 0 });

      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        tags: ["hero-slider"],
      });
    }

    if (type === "site-settings") {
      revalidatePath("/");
      revalidatePath("/blog");
      revalidatePath("/sitemap.xml");
      revalidateTag("site-settings", "max");
      revalidateTag(SITEMAP_TAG, "max");

      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        paths: ["/", "/blog", "/sitemap.xml"],
        tags: ["site-settings", SITEMAP_TAG],
      });
    }

    if (type === "site-identity") {
      // Site identity affects layout, footer, about, contact and metadata everywhere.
      revalidatePath("/", "layout");
      revalidateTag("site-identity", "max");

      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        paths: ["/"],
        tags: ["site-identity"],
      });
    }

    if (type === "faq") {
      revalidatePath("/faq");
      revalidateTag("faq", "max");

      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        paths: ["/faq"],
        tags: ["faq"],
      });
    }

    // Generic path revalidation
    if (path) {
      revalidatePath(path);
      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        path,
      });
    }

    // Tag-based revalidation
    if (tag) {
      revalidateTag(tag, "max");
      return NextResponse.json({
        revalidated: true,
        now: Date.now(),
        tag,
      });
    }

    return NextResponse.json({ error: "Invalid revalidation request" }, { status: 400 });
  } catch (error) {
    console.error("Revalidation error:", error);
    return NextResponse.json(
      { error: "Error revalidating", details: (error as Error).message },
      { status: 500 },
    );
  }
}

// Disable caching for this route
