import React from "react";
import CopyIcon from "../../Icons/CopyIcon";

type Props = {
  value: string | null | undefined;
  onChange: (value: string) => void;
  readOnly?: boolean;
};

export default function CopyTextField({ value, onChange, readOnly }: Props) {
  const safeValue = value ?? "";

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(safeValue);
      } catch (err) {
        console.error("Failed to copy to clipboard:", err);
      }
    } else {
      // Fallback for browsers that don't support clipboard API
      const textArea = document.createElement("textarea");
      textArea.value = safeValue;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand("copy");
      } catch (err) {
        console.error("Failed to copy to clipboard:", err);
      }
      document.body.removeChild(textArea);
    }
  };

  return (
    <div className="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-neutral-200 px-4 py-3">
      <button
        type="button"
        className="flex h-5 w-5 shrink-0 items-center justify-center"
        onClick={handleCopy}
        aria-label="کپی"
      >
        <CopyIcon />
      </button>

      <input
        type="text"
        dir="ltr"
        className={`min-w-0 flex-1 truncate text-sm ${readOnly ? "text-slate-500" : ""}`}
        disabled={readOnly}
        readOnly={readOnly}
        value={safeValue}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
