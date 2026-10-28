"use client";

import ProductsLifecycleView from "@/components/SuperAdmin/Product/list/ProductsLifecycleView";

/**
 * Products: one lifecycle-aware list for All / Published / Drafts / Scheduled
 * / Trash. The tab, search, filters, sort and page live in the URL
 * (`?view=trash&q=…`), so refresh, Back/Forward and shared links keep them.
 */
export default function ProductsPage() {
  return <ProductsLifecycleView />;
}
