"use client";

import { useEffect, useState } from "react";
import type { BlogHeading } from "@/utils/blogHeadings";
import { cn } from "@/lib/utils";

interface BlogSidebarTocProps {
  headings: BlogHeading[];
  className?: string;
}

export default function BlogSidebarToc({ headings, className }: BlogSidebarTocProps) {
  const [activeId, setActiveId] = useState(headings[0]?.id ?? "");
  const headingKey = headings.map((heading) => heading.id).join("|");

  useEffect(() => {
    if (headings.length === 0) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const nextId = visible[0]?.target.id;
        if (nextId) setActiveId(nextId);
      },
      { rootMargin: "-120px 0px -55% 0px", threshold: [0, 1] },
    );

    headings.forEach((heading) => {
      const node = document.getElementById(heading.id);
      if (node) observer.observe(node);
    });

    return () => observer.disconnect();
  }, [headingKey, headings]);

  if (headings.length === 0) return null;

  return (
    <nav
      data-testid="blog-sidebar-toc"
      className={cn(
        "flex flex-col gap-4 rounded-[20px] border border-slate-100 bg-white p-5",
        className,
      )}
      aria-label="عناوین مقاله"
    >
      <h2 className="text-right text-xl font-medium text-neutral-600">عناوین مقاله</h2>
      <ul className="flex flex-col gap-2">
        {headings.map((heading) => {
          const isActive = heading.id === activeId;
          return (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                aria-current={isActive ? "location" : undefined}
                onClick={() => setActiveId(heading.id)}
                className="flex items-center justify-between gap-2.5 rounded-lg border border-slate-100 px-3 py-3"
              >
                <span className="text-right text-xs leading-[21px] text-neutral-600">
                  {heading.text}
                </span>
                <span
                  className={cn(
                    "relative h-3 w-3 shrink-0 rounded-full border",
                    isActive ? "border-infinity-primary" : "border-slate-200",
                  )}
                  aria-hidden
                >
                  {isActive ? (
                    <span className="absolute inset-[3px] rounded-full bg-infinity-primary" />
                  ) : null}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
