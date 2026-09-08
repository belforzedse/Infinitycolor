"use client";

import { useState } from "react";

import type { CategoryEditorialContent } from "@/services/product/categoryEditorial";

type Props = { editorial: CategoryEditorialContent };

export const CATEGORY_EDITORIAL_MOBILE_DISCLOSURE_THRESHOLD = 1_200;

export function needsMobileDisclosure(html: string): boolean {
  return (
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim().length > CATEGORY_EDITORIAL_MOBILE_DISCLOSURE_THRESHOLD
  );
}

function EditorialHtml({ html }: { html: string }) {
  return (
    <div
      className="prose prose-neutral mt-5 max-w-none text-sm leading-8 prose-headings:font-bold prose-headings:text-neutral-900 prose-h3:text-lg prose-h4:text-base prose-a:text-infinity-primary prose-a:underline prose-table:block prose-table:max-w-full prose-table:overflow-x-auto prose-img:h-auto prose-img:max-w-full prose-img:rounded-xl sm:text-base sm:prose-h3:text-xl"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function CategoryEditorialSection({ editorial }: Props) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = `category-editorial-body-${editorial.id}`;
  const usesDisclosure = Boolean(editorial.content && needsMobileDisclosure(editorial.content));

  return (
    <section
      aria-labelledby={`category-editorial-${editorial.id}`}
      dir={editorial.isRtl ? "rtl" : "ltr"}
      className="mx-auto w-full max-w-4xl rounded-2xl border border-neutral-200 bg-white px-5 py-6 sm:px-8 sm:py-8"
    >
      <h2
        id={`category-editorial-${editorial.id}`}
        className="text-xl font-bold leading-8 text-neutral-900 sm:text-2xl"
      >
        {editorial.title}
      </h2>
      {editorial.paragraph ? (
        <p className="mt-4 text-sm leading-8 text-neutral-700 sm:text-base">
          {editorial.paragraph}
        </p>
      ) : null}
      {editorial.content ? (
        usesDisclosure ? (
          <div className="mt-1" data-testid="category-editorial-disclosure">
            <button
              type="button"
              aria-controls={bodyId}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
              className="mt-4 cursor-pointer text-sm font-medium text-infinity-primary sm:hidden"
            >
              {expanded ? "بستن متن" : "ادامه مطلب"}
            </button>
            <div id={bodyId} className={expanded ? "block" : "hidden sm:block"}>
              <EditorialHtml html={editorial.content} />
            </div>
          </div>
        ) : (
          <EditorialHtml html={editorial.content} />
        )
      ) : null}
    </section>
  );
}
