import type { AdaptiveQualitySnapshot } from "./types";

export function applyAdaptiveQualityAttributes(snapshot: AdaptiveQualitySnapshot) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  if (!snapshot.enabled) {
    clearAdaptiveQualityAttributes();
    return;
  }

  root.dataset.aqScope = "storefront";
  root.dataset.aqRendering = snapshot.rendering;
  root.dataset.aqMedia = snapshot.media;
  root.dataset.aqMotion = snapshot.motion;
  root.dataset.aqTransparency = snapshot.reducedTransparency
    ? "reduced"
    : "normal";
}

export function clearAdaptiveQualityAttributes() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  delete root.dataset.aqScope;
  delete root.dataset.aqRendering;
  delete root.dataset.aqMedia;
  delete root.dataset.aqMotion;
  delete root.dataset.aqTransparency;
}

