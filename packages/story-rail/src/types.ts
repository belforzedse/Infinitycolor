import type { ReactNode } from "react";

export type StoryRailMediaType = "image" | "video";

export interface StoryRailMediaAsset {
  id?: number | string;
  url: string;
  alternativeText?: string;
  width?: number;
  height?: number;
  mime?: string;
  formats?: {
    large?: { url: string };
    medium?: { url: string };
    small?: { url: string };
    thumbnail?: { url: string };
  };
}

export interface StoryRailOverlay {
  id: string;
  type: "text" | "sticker" | "shape";
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  content?: string;
  fontSize?: number;
  fontColor?: string;
  fontFamily?: string;
  imageUrl?: string;
}

export interface StoryRailItem {
  id?: number;
  Key: string;
  MediaType: StoryRailMediaType;
  Media?: StoryRailMediaAsset;
  Thumbnail?: StoryRailMediaAsset;
  DurationMs: number;
  CtaLabel?: string | null;
  CtaUrl?: string | null;
  Overlays?: StoryRailOverlay[];
}

export interface StoryRailStory {
  id: number;
  Title: string;
  Items?: StoryRailItem[];
  /** One-release compatibility mirror used only when Items is absent. */
  MediaType: StoryRailMediaType;
  Media?: StoryRailMediaAsset;
  /** Story-level rail cover. */
  Thumbnail?: StoryRailMediaAsset;
  DurationMs: number;
  CtaUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type StorySeenItems = ReadonlyMap<number, ReadonlySet<string>>;

export type ResolveStoryMediaUrl = (url: string) => string;

export type StoryRailPreview =
  | { mode: "image"; url: string }
  | { mode: "video"; src: string }
  | { mode: "empty" };

export interface StoryRailMobileBadgeRenderArgs<TStory extends StoryRailStory> {
  story: TStory;
  isSeen: boolean;
}

export interface StoryRailClassNames {
  root?: string;
  heading?: string;
  scroller?: string;
  scrollerInner?: string;
  list?: string;
  avatarButton?: string;
  mobileCard?: string;
  desktopRing?: string;
}

export interface StoryViewerClassNames {
  overlay?: string;
  progressFill?: string;
}

export type StoryRailMobileLayout = "card" | "avatar";

export interface StoriesAvatarListProps<TStory extends StoryRailStory = StoryRailStory> {
  stories: TStory[];
  seenIds?: Set<number>;
  seenItems?: StorySeenItems;
  onAvatarClick: (index: number) => void;
  resolveMediaUrl: ResolveStoryMediaUrl;
  dir?: "rtl" | "ltr";
  mobileLayout?: StoryRailMobileLayout;
  renderMobileBadge?: (args: StoryRailMobileBadgeRenderArgs<TStory>) => ReactNode;
  emptyPreviewLabel?: string;
  classNames?: Pick<StoryRailClassNames, "list" | "avatarButton" | "mobileCard" | "desktopRing">;
}

export interface StoriesViewerModalProps<TStory extends StoryRailStory = StoryRailStory> {
  stories: TStory[];
  seenIds?: Set<number>;
  seenItems?: StorySeenItems;
  isOpen: boolean;
  initialIndex: number;
  onClose: () => void;
  onStoryView: (storyId: number, itemKey: string) => void;
  resolveMediaUrl: ResolveStoryMediaUrl;
  unavailableText?: string;
  classNames?: StoryViewerClassNames;
  dir?: "rtl" | "ltr";
  labels?: StoryViewerLabels;
}

export interface StoryViewerLabels {
  dialog: (title: string) => string;
  close: string;
  description: string;
  progress: (percent: number) => string;
  announcement: (current: number, total: number, title: string) => string;
  mediaFailure: string;
  retry: string;
  mute: string;
  unmute: string;
}

export interface StoryRailProps<TStory extends StoryRailStory = StoryRailStory> {
  stories: TStory[];
  seenIds?: Set<number>;
  seenItems?: StorySeenItems;
  onMarkSeen: (storyId: number, itemKey: string) => void | Promise<void>;
  resolveMediaUrl: ResolveStoryMediaUrl;
  heading?: ReactNode;
  headingId?: string;
  dir?: "rtl" | "ltr";
  className?: string;
  classNames?: StoryRailClassNames;
  viewerClassNames?: StoryViewerClassNames;
  mobileLayout?: StoryRailMobileLayout;
  renderMobileBadge?: (args: StoryRailMobileBadgeRenderArgs<TStory>) => ReactNode;
  emptyPreviewLabel?: string;
  unavailableText?: string;
  viewerLabels?: StoryViewerLabels;
  /**
   * Show previous/next buttons over the rail when it overflows. Opt-in so the
   * existing rails keep their current look. Pointer-only: touch users swipe,
   * and arrows would sit on top of the avatars at mobile width.
   */
  showPagination?: boolean;
  /** Accessible labels for the pagination buttons; supply localized text. */
  paginationLabels?: { previous: string; next: string };
}
