import Link from "next/link";
import type { BlogCategory } from "@/services/blog/blog.service";
import { cn } from "@/lib/utils";

interface BlogSidebarCategoriesProps {
  categories: BlogCategory[];
  activeSlug?: string;
  className?: string;
}

function categoryLabel(category: BlogCategory): string {
  return category.Title?.trim() || category.Name?.trim() || category.Slug;
}

const rowClassName = (isActive: boolean) =>
  cn(
    "block w-full rounded-lg border border-slate-100 px-3 py-3 text-right text-base transition-colors",
    isActive
      ? "bg-infinity-primary text-white"
      : "text-neutral-500 hover:bg-slate-50",
  );

export default function BlogSidebarCategories({
  categories,
  activeSlug,
  className,
}: BlogSidebarCategoriesProps) {
  const visibleCategories = categories.filter((category) => category.Slug?.trim());
  if (visibleCategories.length === 0) return null;

  return (
    <nav
      data-testid="blog-sidebar-categories"
      className={cn("flex flex-col gap-4 rounded-2xl border border-slate-100 bg-white p-5", className)}
      aria-label="دسته بندی ها"
    >
      <h2 className="text-right text-xl font-medium text-neutral-600">دسته بندی ها</h2>
      <ul className="flex flex-col gap-2">
        <li>
          <Link href="/blog" className={rowClassName(false)}>
            همه
          </Link>
        </li>
        {visibleCategories.map((category) => {
          const isActive = activeSlug === category.Slug;
          return (
            <li key={category.id}>
              <Link
                href={`/blog?category=${encodeURIComponent(category.Slug)}`}
                className={rowClassName(isActive)}
              >
                {categoryLabel(category)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
