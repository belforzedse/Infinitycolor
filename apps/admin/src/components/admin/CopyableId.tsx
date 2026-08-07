"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/utils/tailwind";
import { FOCUS_RING } from "./tokens";

/**
 * A system identifier that stays operationally useful without dominating the
 * visual hierarchy: rendered as secondary text next to a human-readable title,
 * but one tap to copy.
 */
export default function CopyableId({
  value,
  prefix = "#",
  label = "کپی شناسه",
  className,
}: {
  value: string | number;
  prefix?: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = String(value);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timeout);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toast.error("کپی انجام نشد");
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`${label} ${text}`}
      className={cn(
        "text-xs inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-1.5 font-mono text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700",
        FOCUS_RING,
        className,
      )}
      dir="ltr"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      <span>
        {prefix}
        {text}
      </span>
    </button>
  );
}
