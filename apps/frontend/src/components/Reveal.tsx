"use client";

import React from "react";
import { useAdaptiveQuality } from "@/lib/adaptive-quality";

type Variant = "fade-up" | "fade-in" | "fade-right" | "fade-left" | "zoom-in" | "blur-up";

type RevealProps = {
  children: React.ReactNode;
  className?: string;
  delay?: number; // ms
  duration?: number; // ms
  amount?: number; // intersection threshold
  once?: boolean;
  variant?: Variant;
};

export default function Reveal({
  children,
  className,
  delay = 0,
  duration = 700,
  amount = 0.2,
  once = true,
  variant = "fade-up",
}: RevealProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = React.useState(false);
  const quality = useAdaptiveQuality();

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      quality.motion === "minimal" ||
      typeof IntersectionObserver === "undefined"
    ) {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          if (once) observer.unobserve(el);
        } else if (!once) {
          setShown(false);
        }
      },
      { threshold: amount, rootMargin: "0px 0px -10% 0px" },
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [amount, once, quality.motion, quality.routeGeneration]);

  return (
    <div
      ref={ref}
      className={["aq-reveal", className ?? ""].join(" ")}
      data-aq-reveal-state={shown ? "shown" : "hidden"}
      data-aq-reveal-variant={variant}
      style={{
        "--aq-reveal-delay": `${delay}ms`,
        "--aq-reveal-duration": `${duration}ms`,
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
