"use client";

import clsx from "clsx";
import * as Sentry from "@sentry/nextjs";
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  noteEnhancementLoaded,
  useAdaptiveHydrated,
  useAdaptiveQuality,
} from "@/lib/adaptive-quality";

type DotLottieComponent = (typeof import("@lottiefiles/dotlottie-react"))["DotLottieReact"];
type LoaderPlayer = NonNullable<
  Parameters<NonNullable<ComponentProps<DotLottieComponent>["dotLottieRefCallback"]>>[0]
>;

const LOADING_MESSAGE_DELAY_MS = 3000;
const LOADING_ANIMATION_URL = "/animations/infloading.json";
const LOADING_LAYOUT = { fit: "contain" as const, align: [0.5, 0.5] as [number, number] };

class LoaderAnimationBoundary extends Component<
  { children: ReactNode; onFailure: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onFailure(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

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
  const [animationFailed, setAnimationFailed] = useState(false);
  const [visible, setVisible] = useState(true);
  const [DotLottieReact, setDotLottieReact] = useState<DotLottieComponent | null>(null);
  const removePlayerListeners = useRef<(() => void) | null>(null);
  const readyFrame = useRef<number | null>(null);
  const hydrated = useAdaptiveHydrated();
  const quality = useAdaptiveQuality();
  const shouldEnhance =
    hydrated &&
    visible &&
    !animationFailed &&
    quality.rendering === "enhanced" &&
    quality.motion === "enhanced";

  const cleanupPlayer = useCallback(() => {
    removePlayerListeners.current?.();
    removePlayerListeners.current = null;
    if (readyFrame.current !== null) window.cancelAnimationFrame(readyFrame.current);
    readyFrame.current = null;
  }, []);
  const failAnimation = useCallback(
    (error: Error) => {
      cleanupPlayer();
      setShowAnimation(false);
      setAnimationFailed(true);
      try {
        Sentry.captureException(error, {
          tags: {
            area: "loader",
            recovery_surface: "loader-animation",
            recovery_outcome: "fallback",
          },
        });
      } catch {
        /* The decorative fallback must remain independent of reporting. */
      }
    },
    [cleanupPlayer],
  );
  const attachPlayer = useCallback(
    (instance: LoaderPlayer | null) => {
      cleanupPlayer();
      if (!instance) return;
      const loaded = () => {
        if (readyFrame.current !== null) window.cancelAnimationFrame(readyFrame.current);
        readyFrame.current = window.requestAnimationFrame(() => {
          readyFrame.current = null;
          setShowAnimation(true);
        });
      };
      const failed = () => failAnimation(new Error("Loading animation failed"));
      instance.addEventListener("load", loaded);
      instance.addEventListener("loadError", failed);
      instance.addEventListener("renderError", failed);
      removePlayerListeners.current = () => {
        instance.removeEventListener("load", loaded);
        instance.removeEventListener("loadError", failed);
        instance.removeEventListener("renderError", failed);
      };
      if (instance.isLoaded) loaded();
    },
    [cleanupPlayer, failAnimation],
  );

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      cleanupPlayer();
    };
  }, [cleanupPlayer]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setShowMessage(true);
    }, LOADING_MESSAGE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (!shouldEnhance || document.visibilityState !== "visible") {
      cleanupPlayer();
      setShowAnimation(false);
      setAnimationData(null);
      setDotLottieReact(null);
      return;
    }

    let cancelled = false;

    Promise.all([import("@lottiefiles/dotlottie-react"), loadLoadingAnimation()])
      .then(([module, data]) => {
        if (cancelled) return;
        setDotLottieReact(() => module.DotLottieReact);
        setAnimationData(data);
        if (data) noteEnhancementLoaded("lottie-loader");
      })
      .catch(() => {
        if (!cancelled) {
          setDotLottieReact(null);
          setAnimationData(null);
        }
      });

    return () => {
      cancelled = true;
      // The wrapper owns destruction through its canvas ref. Calling stop here
      // competes with that teardown and can re-enter the WASM player.
      cleanupPlayer();
    };
  }, [shouldEnhance, cleanupPlayer]);

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
          {shouldEnhance && animationData && DotLottieReact && (
            <div
              className={clsx(
                "absolute inset-0 transition duration-500 ease-out",
                showAnimation ? "scale-100 opacity-100" : "scale-95 opacity-0",
              )}
            >
              <LoaderAnimationBoundary onFailure={failAnimation}>
                <DotLottieReact
                  data={animationData}
                  loop
                  autoplay
                  dotLottieRefCallback={attachPlayer}
                  layout={LOADING_LAYOUT}
                  className="h-full w-full"
                />
              </LoaderAnimationBoundary>
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
