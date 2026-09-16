"use client";

import { useAtomValue } from "jotai";
import { MessageSquareWarning } from "lucide-react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useState } from "react";

import styles from "./IssueReportWidget.module.css";
import { categoryOverlayOpenAtom } from "@/atoms/storefrontOverlay";
import { generateUuidV4 } from "@/utils/uuid";

/**
 * The dialog carries react-hook-form, the Headless UI dialog stack, the phone
 * validator and the submit service. Until someone actually reports a problem
 * none of that is needed, so it is a separate chunk fetched on the first press.
 *
 * `ssr: false` because the dialog is never part of the server-rendered output
 * anyway: it only exists once `open` has been true.
 */
const IssueReportDialog = dynamic(() => import("./IssueReportDialog"), { ssr: false });

const HIDDEN_PREFIXES = ["/auth", "/super-admin"];

export default function IssueReportWidget() {
  const pathname = usePathname();
  const covered = useAtomValue(categoryOverlayOpenAtom);
  const [open, setOpen] = useState(false);
  // Latched: once the dialog has been opened it stays mounted, so the form keeps
  // its idempotency key and any unsent input across close/reopen.
  const [hasOpened, setHasOpened] = useState(false);
  // Owned here, as before the dialog was split out, so pressing the trigger has
  // the same effect on the success state and the idempotency key as it always did.
  const [sent, setSent] = useState(false);
  const [submissionId, setSubmissionId] = useState<string | null>(null);

  if (!pathname || HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setHasOpened(true);
          setSent(false);
          setSubmissionId((current) => current || generateUuidV4());
          setOpen(true);
        }}
        className={`${styles.trigger} fixed bottom-[calc(env(safe-area-inset-bottom)+7.5rem)] left-3 z-[80] inline-flex min-h-11 items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-xl hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 lg:bottom-6 lg:left-6`}
        hidden={covered || open}
        aria-label="گزارش مشکل"
      >
        <MessageSquareWarning className="h-5 w-5" aria-hidden="true" />
        <span>گزارش مشکل</span>
      </button>

      {hasOpened ? (
        <IssueReportDialog
          open={open}
          onClose={setOpen}
          sent={sent}
          onSent={setSent}
          submissionId={submissionId}
          onSubmissionId={setSubmissionId}
        />
      ) : null}
    </>
  );
}
