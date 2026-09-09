import React from "react";
import { Metadata } from "next";
import { notFound } from "next/navigation";
import BlogPostDetail from "@/components/Blog/BlogPostDetail";
import BlogComments from "@/components/Blog/BlogComments";
import {
  BlogSidebarCategories,
  BlogSidebarPopular,
  BlogSidebarSearch,
  BlogSidebarToc,
} from "@/components/Blog/PostSidebar";
import { blogService, type BlogCardPost, type BlogCategory } from "@/services/blog/blog.service";
import { generateBlogPostMetadata, generateJSONLD } from "@/utils/seo";
import { getStrapiServerUrl } from "@/constants/api";
import { extractBlogHeadings } from "@/utils/blogHeadings";
import logger from "@/utils/logger";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

// Use on-demand revalidation (triggered by Strapi lifecycle hooks)
// Fallback to 1 hour if revalidation API is not called
// This ensures pages stay fresh even if webhook fails
// Allow dynamic generation of blog posts not in generateStaticParams
// This ensures ISR can generate pages on-demand even if build-time generation failed
interface BlogPostPageProps {
  params: Promise<{
    slug: string;
  }>;
}

// Patterns that should NOT be handled as blog posts
const EXCLUDED_PATTERNS = [
  /\.(html|xml|json|txt|ico|png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2|ttf|eot)$/i, // Static files
  /^_next/, // Next.js internal routes
  /^api\//, // API routes
  /^offline/, // Service worker offline page
  /^sw\.js/, // Service worker
  /^manifest/, // Web app manifest
  /^robots\.txt/, // Robots file
  /^sitemap/, // Sitemap
  /^favicon/, // Favicon
  /^(login|register|auth|signin|signup|logout|forgot-password|reset-password)$/i, // Auth routes
  /^super-admin/, // Admin routes
  /^user\//, // User routes
  /^orders/, // Order routes
  /^cart/, // Cart routes
  /^checkout/, // Checkout routes
  /^products/, // Product listing routes
  /^categories/, // Category routes
  /^search/, // Search routes
];

function shouldExcludeSlug(slug: string): boolean {
  return EXCLUDED_PATTERNS.some(pattern => pattern.test(slug));
}

async function loadPostSidebarData(currentSlug: string): Promise<{
  categories: BlogCategory[];
  popular: BlogCardPost[];
}> {
  const [categoriesResult, popularResult] = await Promise.allSettled([
    blogService.getBlogCategories(),
    blogService.getBlogPosts({
      pageSize: 6,
      status: "Published",
      sort: "ViewCount:desc",
    }),
  ]);

  const categories =
    categoriesResult.status === "fulfilled"
      ? (categoriesResult.value.data || [])
          .filter((category) => Boolean(category.Slug?.trim()))
          .filter((category, index, list) => {
            const label = (category.Title || category.Name || category.Slug).trim();
            return (
              list.findIndex(
                (item) => (item.Title || item.Name || item.Slug).trim() === label,
              ) === index
            );
          })
      : [];

  const popular =
    popularResult.status === "fulfilled"
      ? (popularResult.value.data || [])
          .filter((post) => post.Slug !== currentSlug)
          .slice(0, 3)
      : [];

  return { categories, popular };
}

// Generate metadata for SEO
export async function generateMetadata({ params }: BlogPostPageProps): Promise<Metadata> {
  const { slug } = await params;

  // Exclude non-blog routes early to prevent API calls
  if (shouldExcludeSlug(slug)) {
    return {
      title: "صفحه یافت نشد | وبلاگ",
      description: "صفحه مورد نظر یافت نشد.",
    };
  }

  try {
    const { data: post } = await blogService.getBlogPostBySlug(slug);

    return generateBlogPostMetadata({
      title: post.Title,
      slug: post.Slug,
      excerpt: post.Excerpt,
      metaTitle: post.MetaTitle,
      metaDescription: post.MetaDescription,
      keywords: post.Keywords,
      featuredImage: post.FeaturedImage,
      author: post.blog_author,
      category: post.blog_category?.Name ? { Name: post.blog_category.Name } : undefined,
      publishedAt: post.PublishedAt,
      updatedAt: post.updatedAt,
    });
  } catch (error) {
    return {
      title: "پست یافت نشد | وبلاگ",
      description: "پست مورد نظر یافت نشد.",
    };
  }
}


export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const env = process.env.NODE_ENV || 'development';
  const isStaging = process.env.NEXT_PUBLIC_SITE_URL?.includes('staging') || env === 'production';
  const strapiBaseUrl = getStrapiServerUrl();

  // Exclude static files and other non-blog routes
  if (shouldExcludeSlug(slug)) {
    logger.info(`[BlogPostPage] Excluding slug from blog post handling`, {
      slug,
      reason: 'Matches excluded pattern',
      env,
      isStaging,
    });
    notFound();
    return;
  }

  logger.info(`[BlogPostPage] Route handler called`, {
    slug,
    env,
    isStaging,
    strapiBaseUrl: strapiBaseUrl || 'NOT_SET',
    hasStrapiBaseUrl: !!strapiBaseUrl,
    timestamp: new Date().toISOString(),
  });

  const sidebarPromise = loadPostSidebarData(slug);

  let post;

  // Validate server-side Strapi URL before attempting fetch
  if (!strapiBaseUrl || strapiBaseUrl === 'undefined') {
    logger.error(`[BlogPostPage] Strapi server URL is not configured`, {
      slug,
      strapiBaseUrl,
      internalEnvVar: process.env.STRAPI_INTERNAL_URL,
      publicEnvVar: process.env.NEXT_PUBLIC_API_BASE_URL,
      env,
      isStaging,
    });
    logger.error(`[BlogPostPage] Calling notFound() due to missing Strapi server URL`);
    notFound();
    return;
  }

  try {
    logger.info(`[BlogPostPage] Fetching blog post with slug: ${slug}`, {
      slug,
      strapiBaseUrl: strapiBaseUrl || 'NOT_SET',
      env,
      isStaging,
    });

    // Add timeout to prevent hanging requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    let response;
    try {
      response = await blogService.getBlogPostBySlug(slug);
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      // If it's a timeout or network error, return 404 instead of crashing
      if (fetchError instanceof Error && (fetchError.name === 'AbortError' || fetchError.message.includes('timeout'))) {
        logger.error(`[BlogPostPage] Request timeout for slug: ${slug}`, {
          slug,
          error: fetchError.message,
        });
        notFound();
        return;
      }
      throw fetchError; // Re-throw other errors
    }

    if (!response || !response.data) {
      logger.error(`[BlogPostPage] Invalid response structure for slug: ${slug}`, {
        response: response ? { hasData: !!response.data, hasMeta: !!response.meta } : 'null',
        env,
        isStaging,
      });
      logger.error(`[BlogPostPage] Calling notFound() due to invalid response structure`);
      notFound();
      return;
    }

    post = response.data;
    logger.info(`[BlogPostPage] Successfully fetched blog post`, {
      slug,
      postId: post.id,
      title: post.Title || 'NO_TITLE',
      env,
      isStaging,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isNotFoundError = errorMessage.includes('not found') || errorMessage.includes('404');

    logger.error(`[BlogPostPage] Error fetching blog post with slug: ${slug}`, {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      strapiBaseUrl: strapiBaseUrl || 'NOT_SET',
      slug,
      env,
      isStaging,
      isNotFoundError,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });

    logger.error(`[BlogPostPage] Calling notFound() due to fetch error: ${errorMessage}`);
    notFound();
    return;
  }

  const { categories, popular } = await sidebarPromise;
  const { html: contentHtml, headings } = extractBlogHeadings(post.Content || "");

  // Generate JSON-LD structured data
  const jsonLd = generateJSONLD({
    title: post.Title,
    slug: post.Slug,
    excerpt: post.Excerpt,
    metaTitle: post.MetaTitle,
    metaDescription: post.MetaDescription,
    keywords: post.Keywords,
    featuredImage: post.FeaturedImage,
    author: post.blog_author,
    category: post.blog_category?.Name ? { Name: post.blog_category.Name } : undefined,
    publishedAt: post.PublishedAt,
    updatedAt: post.updatedAt,
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="min-h-screen bg-slate-50 py-8" dir="rtl">
        <div className="container mx-auto px-4">
          <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start lg:gap-8">
            <div className="contents min-w-0 lg:col-start-1 lg:flex lg:flex-col lg:gap-4 lg:self-start">
              <BlogSidebarSearch className="order-1 lg:order-none" />
              <div className="hidden lg:block" data-testid="blog-sidebar-categories-slot">
                <BlogSidebarCategories
                  categories={categories}
                  activeSlug={post.blog_category?.Slug}
                />
              </div>
              {headings.length > 0 ? (
                <BlogSidebarToc className="order-3 lg:order-none" headings={headings} />
              ) : null}
              {popular.length > 0 ? (
                <BlogSidebarPopular className="order-5 lg:order-none" posts={popular} />
              ) : null}
            </div>

            <div className="order-4 min-w-0 lg:col-start-2">
              <BlogPostDetail post={post} contentHtml={contentHtml} />
              <div className="mt-12">
                <BlogComments postId={post.id} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
