import { Eye } from "lucide-react";
import BlogCard from "@/components/Blog/BlogCard";
import type { BlogCardPost } from "@/services/blog/blog.service";
import { cn } from "@/lib/utils";

interface BlogSidebarPopularProps {
  posts: BlogCardPost[];
  className?: string;
}

export default function BlogSidebarPopular({ posts, className }: BlogSidebarPopularProps) {
  if (posts.length === 0) return null;

  return (
    <section
      data-testid="blog-sidebar-popular"
      className={cn("flex flex-col gap-3", className)}
      aria-label="مقالات پر بازدید"
    >
      <h2 className="flex items-center justify-end gap-1 text-xl font-medium text-neutral-600">
        مقالات پر بازدید
        <Eye className="h-6 w-6 text-infinity-primary" aria-hidden />
      </h2>
      <div className="flex flex-col gap-3">
        {posts.map((post) => (
          <BlogCard
            key={post.id}
            post={post}
            sizes="(max-width: 1024px) 100vw, 320px"
          />
        ))}
      </div>
    </section>
  );
}
