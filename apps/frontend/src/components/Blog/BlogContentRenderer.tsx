"use client";

import React from "react";
import DOMPurify from "isomorphic-dompurify";
import { parseBlogBlocks, type BlogBlock } from "@/utils/blogShortcodes";
import BlogProductCarousel from "./BlogProductCarousel";
import BlogPromoSection from "./BlogPromoSection";

interface BlogContentRendererProps {
  content: string;
}

/**
 * Renders a blog article: HTML with embedded blocks.
 *
 * The body is split at each block's indices and the pieces are sanitized
 * individually, so a carousel or promotional section appears exactly where the
 * author put it. Both branches carry the same `prose` classes — otherwise an
 * article gained or lost its typography depending on whether it happened to
 * embed anything.
 */
const PROSE_CLASSES =
  "prose prose-md prose-neutral max-w-none prose-headings:scroll-mt-28 prose-headings:font-bold prose-headings:text-neutral-900 prose-h1:text-4xl prose-h2:text-2xl prose-h3:text-xl prose-h4:text-md prose-p:text-neutral-700 prose-a:text-infinity-primary prose-a:no-underline hover:prose-a:underline prose-pre:bg-slate-900 prose-img:rounded-xl";

const BlogContentRenderer: React.FC<BlogContentRendererProps> = ({ content }) => {
  const blocks = parseBlogBlocks(content);

  if (blocks.length === 0) {
    return (
      <div
        className={PROSE_CLASSES}
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }}
        dir="rtl"
      />
    );
  }

  const segments: Array<{ key: string; html?: string; block?: BlogBlock }> = [];
  let cursor = 0;
  blocks.forEach((block, index) => {
    if (block.startIndex > cursor) {
      const html = content.slice(cursor, block.startIndex);
      if (html.trim()) segments.push({ key: `html-${index}`, html });
    }
    segments.push({ key: `block-${index}`, block });
    cursor = block.endIndex;
  });
  if (cursor < content.length) {
    const html = content.slice(cursor);
    if (html.trim()) segments.push({ key: "html-end", html });
  }

  return (
    <div className={PROSE_CLASSES} dir="rtl">
      {segments.map((segment) => {
        if (segment.html !== undefined) {
          return (
            <div
              key={segment.key}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(segment.html) }}
            />
          );
        }
        const block = segment.block!;
        return block.type === "products" ? (
          <BlogProductCarousel key={segment.key} identifiers={block.identifiers} />
        ) : (
          <BlogPromoSection key={segment.key} data={block.data} />
        );
      })}
    </div>
  );
};

export default BlogContentRenderer;

