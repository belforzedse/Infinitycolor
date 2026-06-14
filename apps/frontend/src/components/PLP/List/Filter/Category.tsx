"use client";

import ChevronDownIcon from "@/components/Search/Icons/ChevronDownIcon";
import { normalizeDigits } from "@/utils/faNum";
import React, { useEffect, useMemo, useRef, useState } from "react";

interface CategoryOption {
  id: string | number;
  title: string;
}

interface Props {
  title: string;
  value: string;
  filterOptions: CategoryOption[];
  onOptionSelect?: (optionId: string | number) => void;
  isLoading?: boolean;
  placeholder?: string;
}

/** Normalize for search: ASCII digits + fold common Arabic forms to Persian + lowercase. */
function normalizeForSearch(text: string): string {
  return normalizeDigits(text).replace(/ي/g, "ی").replace(/ك/g, "ک").trim().toLowerCase();
}

const PLPListFilterCategory = ({
  title,
  value,
  filterOptions,
  onOptionSelect,
  isLoading = false,
  placeholder = "انتخاب دسته بندی",
}: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState<CategoryOption>(
    filterOptions[0] || { id: "", title: "" },
  );
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSelectedOption(
      filterOptions.find((option) => option.id === value) || {
        id: "",
        title: "",
      },
    );
  }, [value, filterOptions]);

  const visibleOptions = useMemo(() => {
    const q = normalizeForSearch(search);
    if (!q) return filterOptions;
    return filterOptions.filter((option) => normalizeForSearch(option.title).includes(q));
  }, [filterOptions, search]);

  // Focus the search box when the dropdown opens for type-ahead.
  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
    }
  }, [isOpen]);

  const closeDropdown = () => {
    setIsOpen(false);
    setFocusedIndex(-1);
    setSearch("");
  };

  const handleOptionClick = (option: CategoryOption) => {
    setSelectedOption(option);
    onOptionSelect?.(option.id);
    closeDropdown();
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isLoading || isOpen) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setIsOpen(true);
      setFocusedIndex(0);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDropdown();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((idx) => Math.min(idx + 1, visibleOptions.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((idx) => Math.max(idx - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const option = visibleOptions[focusedIndex] ?? visibleOptions[0];
      if (option) handleOptionClick(option);
    }
  };

  return (
    <div className="rtl rounded-2xl bg-stone-50 p-4">
      <div className="flex items-center justify-between pb-3">
        <h3 className="text-primary text-sm">{title}</h3>
      </div>

      <div className="mt-3">
        <button
          onClick={() => (isOpen ? closeDropdown() : setIsOpen(true))}
          onKeyDown={handleTriggerKeyDown}
          className="flex w-full items-center justify-between rounded-xl bg-white px-3 py-2"
          disabled={isLoading}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
        >
          <span className="text-xs">
            {isLoading ? (
              "در حال بارگذاری..."
            ) : selectedOption?.title ? (
              <span className="text-gray-800">{selectedOption.title}</span>
            ) : (
              // Placeholder shown when no category is selected
              <span className="text-gray-400">{placeholder}</span>
            )}
          </span>
          <ChevronDownIcon
            className={`h-6 w-6 transition-transform ${isOpen ? "rotate-180" : ""}`}
          />
        </button>

        {isOpen && !isLoading && (
          <div className="mt-2 rounded-xl bg-white p-3">
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setFocusedIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="جستجوی دسته بندی"
              aria-label="جستجوی دسته بندی"
              className="text-xs mb-2 w-full rounded-lg bg-stone-50 px-2 py-1.5 text-right text-gray-800 placeholder:text-gray-400 focus:outline-none"
            />
            {visibleOptions.length === 0 ? (
              <p className="text-xs px-2 py-1.5 text-right text-gray-400">دسته بندی‌ای یافت نشد</p>
            ) : (
              <ul className="max-h-60 space-y-2 overflow-y-auto" role="listbox" aria-label={title}>
                {visibleOptions.map((option, idx) => (
                  <li key={option.id}>
                    <button
                      onClick={() => handleOptionClick(option)}
                      onMouseEnter={() => setFocusedIndex(idx)}
                      className={`text-xs w-full rounded-lg px-2 py-1.5 text-right transition-colors hover:bg-stone-50 ${
                        selectedOption.id === option.id ? "text-primary bg-stone-50" : "text-gray-800"
                      } ${focusedIndex === idx ? "ring-primary/30 ring-2" : ""}`}
                      role="option"
                      aria-selected={selectedOption.id === option.id}
                      tabIndex={-1}
                    >
                      {option.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PLPListFilterCategory;
