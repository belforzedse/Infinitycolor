"use client";

import clsx from "clsx";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  noteEnhancementLoaded,
  useAdaptiveHydrated,
  useAdaptiveQuality,
} from "@/lib/adaptive-quality";

const DotLottieReact = dynamic(
  () => import("@lottiefiles/dotlottie-react").then((mod) => mod.DotLottieReact),
  { ssr: false },
);

const LOADING_MESSAGE_DELAY_MS = 3000;
const LOADING_ANIMATION_URL = "/animations/infloading.json";

let loadingAnimationCache: Record<string, unknown> | null = null;
let loadingAnimationPromise: Promise<Record<string, unknown> | null> | null = null;

function loadLoadingAnimation() {
  if (loadingAnimationCache) return Promise.resolve(loadingAnimationCache);

  loadingAnimationPromise ??= fetch(LOADING_ANIMATION_URL, {
    cache: "force-cache",
    headers: {
      "x-skip-global-loader": "1",
    },
  })
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load ${LOADING_ANIMATION_URL}`);
      return response.json() as Promise<Record<string, unknown>>;
    })
    .then((animationData) => {
      loadingAnimationCache = animationData;
      return animationData;
    })
    .catch(() => null);

  return loadingAnimationPromise;
}

type Props = {
  fullscreen?: boolean;
  className?: string;
  message?: string;
};

export default function SuspenseLoader({
  fullscreen = true,
  className,
  message = "در حال بارگزاری",
}: Props) {
  const [showMessage, setShowMessage] = useState(false);
  const [animationData, setAnimationData] = useState<Record<string, unknown> | null>(null);
  const [showAnimation, setShowAnimation] = useState(false);
  const dotLottieRef = useRef<{ stop: () => void } | null>(null);
  const hydrated = useAdaptiveHydrated();
  const quality = useAdaptiveQuality();
  const shouldEnhance =
    hydrated &&
    quality.rendering === "enhanced" &&
    quality.motion === "enhanced";

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setShowMessage(true);
    }, LOADING_MESSAGE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (!shouldEnhance) {
      dotLottieRef.current?.stop();
      dotLottieRef.current = null;
      setShowAnimation(false);
      setAnimationData(null);
      return;
    }

    let cancelled = false;

    loadLoadingAnimation().then((data) => {
      if (!cancelled) {
        setAnimationData(data);
        if (data) noteEnhancementLoaded("lottie-loader");
      }
    });

    return () => {
      cancelled = true;
      dotLottieRef.current?.stop();
      dotLottieRef.current = null;
    };
  }, [shouldEnhance]);

  useEffect(() => {
    if (!animationData) return;

    let frameId = 0;
    frameId = window.requestAnimationFrame(() => {
      setShowAnimation(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [animationData]);

  return (
    <div
      className={clsx(
        fullscreen && "min-h-[50vh] md:min-h-screen",
        "flex w-full items-center justify-center",
        className,
      )}
      dir="rtl"
    >
      <div className="flex min-h-[160px] flex-col items-center justify-center gap-3">
        <div
          className={clsx(
            "relative flex items-center justify-center overflow-hidden",
            fullscreen ? "h-[180px] w-[180px]" : "h-[132px] w-[132px]",
          )}
          aria-hidden="true"
        >
          <div
            className={clsx(
              "absolute inset-0 flex items-center justify-center transition-opacity duration-300 ease-out",
              showAnimation ? "opacity-0" : "opacity-100",
            )}
          >
            <div className="h-12 w-12 animate-spin rounded-full border-2 border-slate-200 border-t-infinity-primary" />
          </div>
          {shouldEnhance && animationData && (
            <div
              className={clsx(
                "absolute inset-0 transition duration-500 ease-out",
                showAnimation ? "scale-100 opacity-100" : "scale-95 opacity-0",
              )}
            >
              <DotLottieReact
                data={animationData}
                loop
                autoplay
                dotLottieRefCallback={(instance) => {
                  dotLottieRef.current = instance;
                }}
                layout={{ fit: "contain", align: [0.5, 0.5] }}
                className="h-full w-full"
              />
            </div>
          )}
        </div>
        <div
          className={clsx(
            "min-h-5 text-sm font-medium text-neutral-600 transition-opacity duration-200",
            showMessage ? "opacity-100" : "opacity-0",
          )}
          aria-live="polite"
        >
          {showMessage ? message : null}
        </div>
      </div>
    </div>
  );
}
