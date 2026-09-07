import React from "react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  name?: string;
  label?: string;
  testId?: string;
  placeholder?: string;
  helper?: React.ReactNode;
};

export default function TextField({
  value,
  onChange,
  readOnly,
  name,
  label,
  testId,
  placeholder,
  helper,
}: Props) {
  return (
    <div className="flex flex-col gap-2">
      <input
        type="text"
        name={name}
        aria-label={label}
        data-testid={testId}
        disabled={readOnly}
        readOnly={readOnly}
        placeholder={placeholder}
        className={`text-sm w-full rounded-lg border border-neutral-200 px-5 py-3 ${
          readOnly ? "text-slate-500" : ""
        }`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />

      {helper && <div className="text-xs text-slate-500">{helper}</div>}
    </div>
  );
}
