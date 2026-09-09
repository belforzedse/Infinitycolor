import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface BlogSidebarSearchProps {
  className?: string;
}

export default function BlogSidebarSearch({ className }: BlogSidebarSearchProps) {
  return (
    <form
      action="/blog"
      method="get"
      data-testid="blog-sidebar-search"
      className={cn(
        "flex h-12 w-full items-center justify-between gap-1 rounded-full border border-slate-50 bg-white py-2 pl-2 pr-5",
        className,
      )}
      dir="ltr"
    >
      <button
        type="submit"
        className="flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-infinity-primary px-2 text-xs text-white transition-transform hover:scale-105 active:scale-95"
      >
        <Search className="h-5 w-5" aria-hidden />
        جستجو
      </button>
      <input
        type="search"
        name="search"
        placeholder="موضوع مورد علاقتو بنویس"
        className="min-w-0 flex-1 bg-transparent text-right text-xs leading-[21px] text-neutral-600 placeholder:text-neutral-400 focus:outline-none"
        dir="rtl"
        aria-label="جستجو در مقالات"
      />
    </form>
  );
}
