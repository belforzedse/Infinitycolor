"use client";

import ChevronDownIcon from "@/components/Search/Icons/ChevronDownIcon";
import { cn } from "@/utils/tailwind";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";

interface Option {
  id: string | number;
  title: string;
  /** Renders the row muted and unselectable; pair with `description` to say why. */
  disabled?: boolean;
  /** Secondary line under the title, and the tooltip when disabled. */
  description?: string;
}

interface Props {
  options: Option[];
  className?: string;
  buttonClassName?: string;
  selectedOption?: string | number;
  iconClassName?: string;
  onOptionSelect?: (optionId: string | number) => void;
}

const SuperAdminTableSelect = ({
  options: filterOptions,
  onOptionSelect,
  className,
  buttonClassName,
  iconClassName,
  selectedOption: selectedOptionId,
}: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useDismissOnOutside(containerRef, isOpen, close, panelRef);
  const [selectedOption, setSelectedOption] = useState<Option>({
    id: "",
    title: "",
  });

  // Portaled panels render outside this file's ancestor tree, so they need
  // document.body to exist first (guards SSR) and their own position, since
  // `position: fixed` can no longer inherit placement from a relative parent
  // clipped by the table's `overflow-x-auto overflow-y-clip` scroll wrapper.
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 8,
      // clientWidth excludes the scrollbar; innerWidth includes it, which
      // shifted the panel left by the scrollbar's width on any page tall
      // enough to have one.
      right: document.documentElement.clientWidth - rect.right,
    });
  }, [isOpen]);

  // The panel is `position: fixed`, so it visually detaches from its trigger
  // once the page or the table's own scroll container moves; closing (rather
  // than tracking) avoids a floating panel stuck in a stale position. Scroll
  // *inside* the panel's own option list (long lists, e.g. the shipping-cities
  // page) must not trigger this — it isn't a detach, and would slam the panel
  // shut on the first swipe.
  useEffect(() => {
    if (!isOpen) return;

    const onScroll = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      close();
    };

    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);

    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [isOpen, close]);

  useEffect(() => {
    setTimeout(() => {
      setSelectedOption(
        filterOptions.find(
          (option) => +option.id === +(selectedOptionId || -1),
        ) ||
          filterOptions.find((option) => option.id === selectedOptionId) ||
          filterOptions[0] || {
            id: "",
            title: "",
          },
      );
    }, 100);
  }, [filterOptions, selectedOptionId]);

  const handleOptionClick = (option: Option) => {
    if (option.disabled) return;
    setSelectedOption(option);
    onOptionSelect?.(option.id);
    setIsOpen(false);
  };

  return (
    <div
      ref={containerRef}
      className={cn("relative rounded-lg border border-slate-100", className)}
    >
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={cn(
          "flex w-full min-w-0 items-center justify-between gap-2 rounded-xl bg-white px-3 py-2",
          buttonClassName,
        )}
      >
        <span className="min-w-0 truncate text-xs text-gray-800">
          {selectedOption.title}
        </span>
        <ChevronDownIcon
          className={cn(
            "h-6 w-6 shrink-0 transition-transform",
            iconClassName,
            isOpen ? "rotate-180" : "",
          )}
        />
      </button>

      {isOpen &&
        mounted &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: position.top, right: position.right }}
            className="fixed z-50 max-w-[calc(100vw-2rem)] rounded-xl bg-white p-3 shadow-lg"
          >
            <ul className="max-h-64 min-w-32 max-w-full space-y-2 overflow-y-auto">
              {filterOptions.map((option) => (
                <li key={option.id} className="w-full">
                  <button
                    type="button"
                    onClick={() => handleOptionClick(option)}
                    disabled={option.disabled}
                    aria-disabled={option.disabled}
                    title={option.description}
                    className={`text-xs w-full min-w-0 rounded-lg px-2 py-1.5 text-right transition-colors ${
                      option.disabled
                        ? "cursor-not-allowed text-gray-400"
                        : selectedOption.id === option.id
                          ? "text-primary bg-stone-50 hover:bg-stone-50"
                          : "text-gray-800 hover:bg-stone-50"
                    }`}
                  >
                    <span className="block truncate">{option.title}</span>
                    {option.description && (
                      <span className="block truncate text-[11px] text-gray-400">
                        {option.description}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
};

export default SuperAdminTableSelect;
