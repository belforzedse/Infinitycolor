import { getHomeDemoPosts, isSocialHomePostsDemoEnabled } from "@/components/posts/home-posts-demo";
import { HomePostsCollage } from "@/components/posts/HomePostsCollage";
import { getHomeFeedPosts } from "@/services/feed-post.service";
import { cacheLife, cacheTag } from "next/cache";

async function getCachedHomeFeedPosts() {
  "use cache: remote";
  cacheLife("socialPublic");
  cacheTag("social-posts");
  return getHomeFeedPosts({ revalidate: 300 });
}

/**
 * Async island for `<Suspense>` — renders [`HomePostsCollage`](./HomePostsCollage.tsx).
 * Set **`NEXT_PUBLIC_SOCIAL_HOME_POSTS_DEMO=true`** (or `1` / `yes`) to use Picsum placeholders instead of **`GET /posts`**.
 */
export async function HomePostsFeedSection() {
  const posts = isSocialHomePostsDemoEnabled() ? getHomeDemoPosts() : await getCachedHomeFeedPosts();
  return <HomePostsCollage posts={posts} likeMode="api" />;
}
