"use client";

import ChevronDownIcon from "@/components/Search/Icons/ChevronDownIcon";
import type { ProductCategorySummary } from "@/services/product/categories";
import {
  buildGroupedCategorySections,
  type GroupedCategoryOption,
  type GroupedCategorySection,
} from "@/utils/categoryGroups";
import { normalizeDigits } from "@/utils/faNum";
import React, { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  title: string;
  value: string;
  categories: ProductCategorySummary[];
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
  categories,
  onOptionSelect,
  isLoading = false,
  placeholder = "انتخاب دسته بندی",
}: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedSectionKeys, setExpandedSectionKeys] = useState<Set<string>>(new Set());
  const [selectedOptionOverride, setSelectedOptionOverride] =
    useState<GroupedCategoryOption | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const sections = useMemo(() => buildGroupedCategorySections(categories), [categories]);
  const allOptions = useMemo(() => sections.flatMap((section) => section.options), [sections]);

  const selectedOption = useMemo(
    () =>
      selectedOptionOverride ??
      allOptions.find((option) => option.id === value || String(option.categoryId) === value) ??
      null,
    [allOptions, selectedOptionOverride, value],
  );

  const selectedSectionKey = useMemo(() => {
    if (!selectedOption) return null;
    return (
      sections.find((section) =>
        section.options.some((option) => option.categoryId === selectedOption.categoryId),
      )?.key ?? null
    );
  }, [sections, selectedOption]);

  const filteredSections = useMemo(() => {
    const q = normalizeForSearch(search);
    if (!q) return sections;

    return sections
      .map((section) => ({
        ...section,
        options: section.options.filter((option) => {
          const searchableText = [option.title, option.parentTitle, section.title]
            .filter(Boolean)
            .join(" ");
          return normalizeForSearch(searchableText).includes(q);
        }),
      }))
      .filter((section) => section.options.length > 0);
  }, [sections, search]);

  const hasSearch = normalizeForSearch(search).length > 0;

  const visibleOptions = useMemo(
    () =>
      filteredSections.flatMap((section) =>
        hasSearch || expandedSectionKeys.has(section.key) ? section.options : [],
      ),
    [expandedSectionKeys, filteredSections, hasSearch],
  );

  useEffect(() => {
    setSelectedOptionOverride(null);
  }, [value, categories]);

  // Focus the search box when the dropdown opens for type-ahead.
  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || sections.length === 0) return;

    setExpandedSectionKeys((current) => {
      if (current.size > 0) return current;
      return new Set([selectedSectionKey ?? sections[0].key]);
    });
  }, [isOpen, sections, selectedSectionKey]);

  useEffect(() => {
    if (!selectedSectionKey) return;
    setExpandedSectionKeys((current) => {
      if (current.has(selectedSectionKey)) return current;
      const next = new Set(current);
      next.add(selectedSectionKey);
      return next;
    });
  }, [selectedSectionKey]);

  const closeDropdown = () => {
    setIsOpen(false);
    setFocusedIndex(-1);
    setSearch("");
  };

  const toggleSection = (section: GroupedCategorySection) => {
    setExpandedSectionKeys((current) => {
      const next = new Set(current);
      if (next.has(section.key)) {
        next.delete(section.key);
      } else {
        next.add(section.key);
      }
      return next;
    });
  };

  const handleOptionClick = (option: GroupedCategoryOption) => {
    setSelectedOptionOverride(option);
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
        <h3 className="text-sm text-primary">{title}</h3>
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
              className="mb-2 w-full rounded-lg bg-stone-50 px-2 py-1.5 text-right text-xs text-gray-800 placeholder:text-gray-400 focus:outline-none"
            />
            {filteredSections.length === 0 ? (
              <p className="px-2 py-1.5 text-right text-xs text-gray-400">دسته بندی‌ای یافت نشد</p>
            ) : (
              <ul className="max-h-72 space-y-2 overflow-y-auto" role="listbox" aria-label={title}>
                {filteredSections.map((section) => {
                  const isExpanded = hasSearch || expandedSectionKeys.has(section.key);

                  return (
                    <li key={section.key} className="rounded-lg bg-stone-50/70">
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={() => {
                          if (!hasSearch) toggleSection(section);
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-right text-xs font-semibold text-gray-800 transition-colors hover:bg-stone-100"
                      >
                        <span className="truncate">{section.title}</span>
                        <ChevronDownIcon
                          className={`h-5 w-5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        />
                      </button>

                      {isExpanded && (
                        <ul className="space-y-1 px-1 pb-2" role="group" aria-label={section.title}>
                          {section.options.map((option) => {
                            const optionIndex = visibleOptions.findIndex(
                              (item) => item.categoryId === option.categoryId,
                            );
                            const isSelected = selectedOption?.categoryId === option.categoryId;
                            const isFocused = focusedIndex === optionIndex;

                            return (
                              <li key={option.categoryId}>
                                <button
                                  onClick={() => handleOptionClick(option)}
                                  onMouseEnter={() => setFocusedIndex(optionIndex)}
                                  className={`w-full rounded-lg px-2 py-1.5 text-right text-xs transition-colors hover:bg-white ${
                                    isSelected ? "bg-white text-primary" : "text-gray-800"
                                  } ${isFocused ? "ring-2 ring-primary/30" : ""}`}
                                  role="option"
                                  aria-selected={isSelected}
                                  tabIndex={-1}
                                >
                                  <span
                                    className="block truncate"
                                    style={{ paddingRight: `${option.depth * 0.75}rem` }}
                                  >
                                    {option.title}
                                  </span>
                                  {hasSearch && (option.parentTitle || section.title) && (
                                    <span className="mt-0.5 block truncate text-[10px] text-gray-400">
                                      {[section.title, option.parentTitle]
                                        .filter(Boolean)
                                        .join(" / ")}
                                    </span>
                                  )}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PLPListFilterCategory;
