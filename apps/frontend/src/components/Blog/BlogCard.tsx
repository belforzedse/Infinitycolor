"use client";

import React from "react";
import Link from "next/link";
import { Calendar, LayoutGrid } from "lucide-react";
import BlurImage from "@/components/ui/BlurImage";
import imageLoader from "@/utils/imageLoader";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import type { BlogCardPost } from "@/services/blog/blog.service";
import { formatFaDate } from "@/utils/faNum";

interface BlogCardProps {
  post: BlogCardPost;
  priority?: boolean;
  className?: string;
  sizes?: string;
}

const BlogCard: React.FC<BlogCardProps> = ({
  post,
  priority = false,
  className = "",
  sizes = "(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 328px",
}) => {
  const getImageUrl = () => {
    if (!post.FeaturedImage) return null;
    const url =
      post.FeaturedImage.formats?.medium?.url ||
      post.FeaturedImage.formats?.small?.url ||
      post.FeaturedImage.url;
    if (!url) return null;
    return resolveAssetUrl(url) || null;
  };

  const imageUrl = getImageUrl();
  const categoryName =
    post.blog_category?.Name?.trim() || post.blog_category?.Title?.trim() || "اینفینیتی";

  return (
    <article className={`group h-full w-full min-w-0 max-w-none ${className}`}>
      <Link
        href={`/${post.Slug}`}
        className="flex h-full min-w-0 flex-col rounded-3xl border-2 border-infinity-primary-lighter/40 bg-white p-2 transition-all duration-200 hover:border-infinity-primary-lighter/60 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2"
      >
        <div className="relative mb-2 aspect-[304/260] w-full shrink-0 overflow-hidden rounded-[20px]">
          {imageUrl ? (
            <BlurImage
              src={imageUrl}
              alt={post.Title}
              fill
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              sizes={sizes}
              priority={priority}
              loader={imageLoader}
            />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-infinity-primary-lighter/20 to-infinity-primary-lighter/30" />
          )}
        </div>

        <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex min-w-0 items-center gap-1">
            <LayoutGrid className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
            <span className="line-clamp-1 text-xs leading-[1.74] text-neutral-400">
              {categoryName}
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1">
            <Calendar className="h-4 w-4 text-neutral-400" aria-hidden />
            <span className="text-xs leading-[1.74] text-neutral-400">
              {formatFaDate(post.PublishedAt || post.createdAt)}
            </span>
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
          <h3 className="line-clamp-2 min-h-[56px] w-full text-right text-lg font-medium text-neutral-700">
            {post.Title}
          </h3>
          <p className="line-clamp-2 w-full text-right text-xs leading-[1.74] text-neutral-400">
            {post.Excerpt || post.ShortContent}
          </p>
        </div>
      </Link>
    </article>
  );
};

export default BlogCard;
