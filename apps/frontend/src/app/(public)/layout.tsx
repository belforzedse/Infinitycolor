import AdaptiveQualityBoundary from "@/components/AdaptiveQuality/AdaptiveQualityBoundary";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdaptiveQualityBoundary>
      <div className="public-layout">{children}</div>
    </AdaptiveQualityBoundary>
  );
}
