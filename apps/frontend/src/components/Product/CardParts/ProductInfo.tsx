"use client";

import { type FC } from "react";
import GridIcon from "../Icons/GridIcon";

interface ProductInfoProps {
  category: string;
  title: string;
  /** Kept for API compatibility; view count is intentionally not displayed to customers. */
  seenCount?: number;
}

export const ProductInfo: FC<ProductInfoProps> = ({ category, title }) => {
  return (
    <div className="min-h-[58px] flex-grow px-1 py-1 text-right md:py-2" dir="rtl">
      <div className="flex items-center justify-start">
        <div className="flex min-w-0 items-center gap-1">
          <GridIcon className="text-neutral-400" />
          <span className="truncate text-xs text-neutral-400 3xl:text-sm">{category}</span>
        </div>
      </div>

      <h3 className="mt-0.5 line-clamp-1 text-base text-neutral-800 3xl:text-lg">{title}</h3>
    </div>
  );
};
