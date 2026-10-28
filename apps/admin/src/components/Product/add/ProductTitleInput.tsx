"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Input } from "@/components/ui/Input";
import { useProductTitleKeywords } from "@/hooks/product/useProductTitleKeywords";
import {
  getProductTitleSuggestions,
  getProductTitleWordAtCursor,
  replaceProductTitleWord,
} from "@/utils/product-title-suggestions";
import ProductTitleSuggestions from "./ProductTitleSuggestions";

interface ProductTitleInputProps {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export default function ProductTitleInput({
  value,
  disabled = false,
  onChange,
}: ProductTitleInputProps) {
  const inputId = useId();
  const listId = `${inputId}-suggestions`;

  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCursor = useRef<number | null>(null);

  const keywords = useProductTitleKeywords();

  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [composing, setComposing] = useState(false);

  const range = getProductTitleWordAtCursor(value, cursor);

  const suggestions =
    disabled || composing || !range
      ? []
      : getProductTitleSuggestions(range.word, keywords);

  const visible = open && suggestions.length > 0;
  const selectedIndex = visible
    ? activeIndex >= 0 && activeIndex < suggestions.length
      ? activeIndex
      : 0
    : -1;
  useLayoutEffect(() => {
    const position = pendingCursor.current;
    const input = inputRef.current;

    if (position === null || !input) return;

    pendingCursor.current = null;

    if (input.matches(":disabled")) return;

    input.focus({ preventScroll: true });
    input.setSelectionRange(position, position);
  }, [value]);

  const syncCursor = (input: HTMLInputElement) => {
    setCursor(input.selectionStart ?? input.value.length);
    setActiveIndex(-1);

    if (input.selectionStart !== input.selectionEnd) {
      setOpen(false);
    }
  };

  const chooseSuggestion = (word: string) => {
    const input = inputRef.current;

    if (disabled || !range || !input || input.matches(":disabled")) {
      return;
    }

    const result = replaceProductTitleWord(value, range, word);

    pendingCursor.current = result.cursor;

    onChange(result.title);
    setCursor(result.cursor);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      disabled ||
      composing ||
      event.nativeEvent.isComposing ||
      event.currentTarget.matches(":disabled")
    ) {
      return;
    }

    if (event.key === "Tab") {
      setOpen(false);
      return;
    }

    if (event.key === "Escape") {
      if (visible) event.preventDefault();
      setOpen(false);
      return;
    }

    if (
      suggestions.length === 0 ||
      event.currentTarget.selectionStart !== event.currentTarget.selectionEnd
    ) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((selectedIndex + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(
        selectedIndex <= 0 ? suggestions.length - 1 : selectedIndex - 1,
      );
    } else if (event.key === "Enter" && selectedIndex >= 0) {
      event.preventDefault();
      chooseSuggestion(suggestions[selectedIndex]);
    }
  };

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <label htmlFor={inputId} className="text-base text-gray-700">
        نام محصول
      </label>

      <div className="relative">
        <Input
          ref={inputRef}
          id={inputId}
          type="text"
          name="name"
          dir="rtl"
          value={value}
          disabled={disabled}
          autoComplete="off"
          placeholder="نام محصول"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={
            selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined
          }
          className="w-full text-right text-neutral-800 placeholder:text-gray-400"
          onChange={(event) => {
            if (disabled) return;

            onChange(event.currentTarget.value);
            syncCursor(event.currentTarget);
            setOpen(true);
          }}
          onSelect={(event) => syncCursor(event.currentTarget)}
          onFocus={(event) => {
            syncCursor(event.currentTarget);
            setOpen(
              event.currentTarget.selectionStart ===
                event.currentTarget.selectionEnd,
            );
          }}
          onClick={(event) => {
            syncCursor(event.currentTarget);
            setOpen(
              event.currentTarget.selectionStart ===
                event.currentTarget.selectionEnd,
            );
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            setComposing(true);
            setOpen(false);
          }}
          onCompositionEnd={(event) => {
            setComposing(false);
            syncCursor(event.currentTarget);
            setOpen(true);
          }}
        />

        {visible && (
          <ProductTitleSuggestions
            id={listId}
            suggestions={suggestions}
            activeIndex={selectedIndex}
            disabled={disabled}
            onChoose={chooseSuggestion}
          />
        )}
      </div>
    </div>
  );
}
