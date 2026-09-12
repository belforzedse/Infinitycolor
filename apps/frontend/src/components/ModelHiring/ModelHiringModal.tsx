"use client";

import { useAtomValue } from "jotai";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { modelHiringModalOpenAtom } from "@/atoms/modelHiring";

/**
 * Gate only. The modal is opened from a footer link, so on a normal page view
 * its form is never rendered — and until it is, nothing of it needs to be
 * downloaded, parsed or hydrated.
 *
 * Once opened the content stays mounted so the in-flight idempotency key and
 * any picked photos survive a close/reopen, matching the previous behaviour.
 */
const ModelHiringModalContent = dynamic(() => import("./ModelHiringModalContent"), { ssr: false });

const HIDDEN_PREFIXES = ["/auth", "/super-admin"];

export default function ModelHiringModal() {
  const pathname = usePathname();
  const open = useAtomValue(modelHiringModalOpenAtom);
  const [hasOpened, setHasOpened] = useState(open);

  // Adjusting state during render (rather than in an effect) keeps the first
  // open in a single render pass; React re-renders immediately with the latch set.
  if (open && !hasOpened) setHasOpened(true);

  if (!pathname || HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  if (!hasOpened) return null;

  return <ModelHiringModalContent />;
}
