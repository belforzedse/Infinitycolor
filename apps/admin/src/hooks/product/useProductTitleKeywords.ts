"use client";

import { useEffect, useState } from "react";
import { getProductTitleKeywords } from "@/services/super-admin/product/title-keywords";
import { PRODUCT_TITLE_KEYWORDS_CHANGED } from "@/services/super-admin/product/title-keywords-events";

export function useProductTitleKeywords(): string[] {
  const [keywords, setKeywords] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    let requestVersion = 0;

    const loadKeywords = () => {
      const version = ++requestVersion;

      getProductTitleKeywords()
        .then((words) => {
          if (active && version === requestVersion) {
            setKeywords(words);
          }
        })
        .catch(() => undefined);
    };

    loadKeywords();

    window.addEventListener(PRODUCT_TITLE_KEYWORDS_CHANGED, loadKeywords);

    window.addEventListener("focus", loadKeywords);

    return () => {
      active = false;

      window.removeEventListener(PRODUCT_TITLE_KEYWORDS_CHANGED, loadKeywords);

      window.removeEventListener("focus", loadKeywords);
    };
  }, []);

  return keywords;
}
