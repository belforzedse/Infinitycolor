"use client";

interface ProductTitleSuggestionsProps {
  id: string;
  suggestions: string[];
  activeIndex: number;
  disabled?: boolean;
  onChoose: (word: string) => void;
}

export default function ProductTitleSuggestions({
  id,
  suggestions,
  activeIndex,
  disabled = false,
  onChoose,
}: ProductTitleSuggestionsProps) {
  if (disabled || suggestions.length === 0) {
    return null;
  }

  return (
    <ul
      id={id}
      role="listbox"
      aria-label="پیشنهادهای نام محصول"
      dir="rtl"
      className="absolute inset-x-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-lg"
    >
      {suggestions.map((word, index) => (
        <li key={word} role="presentation">
          <button
            id={`${id}-${index}`}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(word)}
            className={`w-full rounded-md px-3 py-2 text-right text-sm text-gray-800 hover:bg-slate-100 ${
              index === activeIndex ? "bg-slate-100" : ""
            }`}
          >
            {word}
          </button>
        </li>
      ))}
    </ul>
  );
}
