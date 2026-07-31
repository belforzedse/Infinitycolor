import AdaptiveQualityBoundary from "@/components/AdaptiveQuality/AdaptiveQualityBoundary";

export default function CategoriesLayout({ children }: { children: React.ReactNode }) {
  return <AdaptiveQualityBoundary>{children}</AdaptiveQualityBoundary>;
}

