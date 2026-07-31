import AdaptiveQualityBoundary from "@/components/AdaptiveQuality/AdaptiveQualityBoundary";

export default function OrdersLayout({ children }: { children: React.ReactNode }) {
  return <AdaptiveQualityBoundary>{children}</AdaptiveQualityBoundary>;
}

