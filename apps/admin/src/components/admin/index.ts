/**
 * Shared admin primitives.
 *
 * Import from here rather than reaching into individual files, so the surface
 * stays visible and duplicate one-off implementations are easy to spot.
 */

export { default as StatusBadge, type BadgeTone } from "./StatusBadge";
export { default as SubNav, type SubNavItem } from "./SubNav";
export { default as MetricCard, MetricGrid, formatMetric } from "./MetricCard";
export type { MetricDelta, MetricFormat } from "./MetricCard";
export { default as CopyableId } from "./CopyableId";
export { default as DetailHeader } from "./DetailHeader";
export {
  default as OverflowMenu,
  type OverflowAction,
} from "./OverflowMenu";
export { default as ActionBar, ACTION_BAR_SCROLL_PADDING } from "./ActionBar";
export {
  ResourceList,
  ResourceListItem,
  ResourceListItemControl,
} from "./ResourceList";
export { AdminCard, AdminSection, AdminStack } from "./AdminSection";
export {
  EmptyState,
  FilteredEmptyState,
  ErrorState,
  PermissionState,
  NotFoundState,
  InlineLoadingState,
  RefreshingOverlay,
} from "./states";
export {
  SkeletonBlock,
  SkeletonText,
  ResourceListSkeleton,
  TableSkeleton,
  ResourceIndexSkeleton,
  MetricCardSkeleton,
  MetricGridSkeleton,
  ChartSkeleton,
  ResourceDetailSkeleton,
} from "./skeletons";
export * from "./tokens";
