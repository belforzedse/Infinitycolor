import AdaptiveQualityBoundary from "@/components/AdaptiveQuality/AdaptiveQualityBoundary";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdaptiveQualityBoundary>
      <div className="public-layout">{children}</div>
    </AdaptiveQualityBoundary>
  );
}
