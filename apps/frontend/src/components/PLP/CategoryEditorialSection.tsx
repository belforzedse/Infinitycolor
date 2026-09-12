"use client";

import { useState } from "react";

import Reveal from "@/components/Reveal";
import Voice from "@/components/Kits/Voice";
import type { CategoryEditorialContent } from "@/services/product/categoryEditorial";
import resolveAssetUrl from "@/utils/resolveAssetUrl";

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
      className="prose prose-neutral mt-5 max-w-none whitespace-pre-line text-sm leading-8 text-neutral-500 prose-headings:font-bold prose-headings:text-neutral-900 prose-h3:text-lg prose-h4:text-base prose-p:my-3 prose-p:leading-8 prose-a:text-infinity-primary prose-a:underline prose-li:leading-8 prose-table:block prose-table:max-w-full prose-table:overflow-x-auto prose-img:h-auto prose-img:max-w-full prose-img:rounded-2xl sm:text-base sm:leading-9 sm:prose-h3:text-xl sm:prose-p:leading-9 sm:prose-li:leading-9"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function CategoryEditorialSection({ editorial }: Props) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = `category-editorial-body-${editorial.id}`;
  const usesDisclosure = Boolean(editorial.content && needsMobileDisclosure(editorial.content));

  return (
    <Reveal className="mx-auto w-full max-w-5xl" amount={0.1} duration={450} variant="fade-up">
      <section
        aria-labelledby={`category-editorial-${editorial.id}`}
        dir={editorial.isRtl ? "rtl" : "ltr"}
        className="w-full py-6 sm:py-10"
      >
        <div className="me-auto w-full max-w-4xl text-start">
          <h2
            id={`category-editorial-${editorial.id}`}
            className="text-2xl font-medium leading-10 text-neutral-800 sm:text-3xl sm:leading-[1.6]"
          >
            {editorial.title}
          </h2>
          {editorial.paragraph ? (
            <p className="mt-4 text-sm leading-8 text-neutral-500 sm:text-base sm:leading-9">
              {editorial.paragraph}
            </p>
          ) : null}
          {editorial.content ? (
            usesDisclosure ? (
              <div className="mt-1" data-testid="category-editorial-disclosure">
                <div
                  id={bodyId}
                  data-state={expanded ? "open" : "closed"}
                  data-aq-motion-sensitive
                  className={`grid overflow-hidden transition-[grid-template-rows,opacity,visibility] duration-200 [transition-timing-function:var(--ease-butter)] motion-reduce:transition-none sm:visible sm:grid-rows-[1fr] sm:opacity-100 sm:transition-none ${
                    expanded
                      ? "visible grid-rows-[1fr] opacity-100"
                      : "invisible grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <div className="min-h-0 overflow-hidden">
                    <EditorialHtml html={editorial.content} />
                  </div>
                </div>
                <button
                  type="button"
                  aria-controls={bodyId}
                  aria-expanded={expanded}
                  data-aq-motion-sensitive
                  onClick={() => setExpanded((current) => !current)}
                  className="mt-4 inline-flex min-h-11 cursor-pointer items-center rounded-xl px-3 py-2 text-sm font-medium text-infinity-primary transition-[background-color,color,transform] duration-150 ease-out hover:bg-infinity-primary-lighter/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none sm:hidden"
                >
                  {expanded ? "بستن متن" : "ادامه مطلب"}
                </button>
              </div>
            ) : (
              <EditorialHtml html={editorial.content} />
            )
          ) : null}
          {editorial.audio ? (
            <Voice
              audioSrc={resolveAssetUrl(editorial.audio.url)}
              label={`فایل صوتی ${editorial.title}`}
              className="mt-6"
            />
          ) : null}
        </div>
      </section>
    </Reveal>
  );
}
