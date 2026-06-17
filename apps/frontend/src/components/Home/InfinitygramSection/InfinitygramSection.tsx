import dynamic from "next/dynamic";
import { getSocialFeedPosts } from "@repo/social-posts";

const InfinitygramSectionClient = dynamic(() => import("./InfinitygramSectionClient"));

const HOME_INFINITYGRAM_LIMIT = 6;

export default async function InfinitygramSection() {
  const posts = await getSocialFeedPosts({
    limit: HOME_INFINITYGRAM_LIMIT,
    includeRelationCounts: true,
    revalidate: 60,
  });

  if (posts.length === 0) return null;

  return <InfinitygramSectionClient posts={posts} />;
}
