"use client";

import { SocialPostCard, SocialPostOverlayBadge } from "@repo/social-posts/client";
import type { PostCardVariant } from "@repo/social-posts/client";
import type { SocialFeedPost } from "@repo/social-posts";

const INFINITYGRAM_URL = "https://infinitygram.co";
const EXTERNAL_LINK_PROPS = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const;

function hrefForPost(slug: string) {
  return `${INFINITYGRAM_URL}/post/${encodeURIComponent(slug)}`;
}

function cellClass(post: SocialFeedPost) {
  return post.desktopVariant === "xl" ? "col-span-2 row-span-2" : "col-span-1 row-span-1";
}

function PostCard({
  post,
  variant,
  className,
}: {
  post: SocialFeedPost;
  variant: PostCardVariant;
  className?: string;
}) {
  return (
    <SocialPostCard
      variant={variant}
      widthMode="fluid"
      fluidMaxWidth="none"
      className={className}
      imageSrc={post.imageSrc}
      imageAlt={post.imageAlt}
      previewMedia={post.previewMedia}
      likesCount={post.likesCount}
      commentsCount={post.commentsCount}
      href={hrefForPost(post.slug)}
      linkTarget={EXTERNAL_LINK_PROPS.target}
      linkRel={EXTERNAL_LINK_PROPS.rel}
      linkAriaLabel={`مشاهده پست ${post.title || post.imageAlt}`}
      actionTone="light"
      overlay={post.overlay != null ? <SocialPostOverlayBadge type={post.overlay} /> : undefined}
    />
  );
}

export default function InfinitygramRichPosts({ posts }: { posts: readonly SocialFeedPost[] }) {
  return (
    <div
      className="grid w-full min-w-0 grid-flow-dense grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
      dir="ltr"
    >
      {posts.map((post) => (
        <div key={post.id} className={`${cellClass(post)} flex min-w-0 justify-center`} dir="ltr">
          <PostCard post={post} variant={post.desktopVariant} className="w-full" />
        </div>
      ))}
    </div>
  );
}
