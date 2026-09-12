import { Fragment, useId, useMemo, useState } from "react";
import { Combobox, Listbox, Transition } from "@headlessui/react";
import ArrowDownIcon from "@/components/Product/Icons/ArrowDownIcon";
import classNames from "classnames";

export interface Option {
  id: number | string;
  name: string;
}

interface SelectProps {
  label?: string;
  value?: Option | null;
  onChange: (value: Option) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  selectButtonClassName?: string;
  isLoading?: boolean;
  error?: string;
  emptyMessage?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}

const normalizeSearchText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .trim()
    .toLocaleLowerCase("fa-IR")
    .replace(/\s+/g, " ");

export default function Select({
  label,
  value = null,
  onChange,
  options,
  placeholder = "انتخاب کنید",
  className = "",
  selectButtonClassName,
  isLoading = false,
  error,
  emptyMessage = "موردی یافت نشد",
  searchable = false,
  searchPlaceholder,
}: SelectProps) {
  const controlId = useId();
  const [query, setQuery] = useState("");
  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return options;
    return options.filter((option) =>
      normalizeSearchText(option.name).includes(normalizedQuery),
    );
  }, [options, query]);

  const controlClassName = classNames(
    "focus:ring-primary-500/20 focus:border-primary-500 relative w-full rounded-control border p-3 text-right text-sm focus:outline-none focus:ring-2",
    {
      "border-red-500": error,
      "border-slate-100": !error,
      "cursor-not-allowed opacity-75": isLoading,
    },
    selectButtonClassName,
  );

  const optionsClassName =
    "absolute z-[60] mt-1 max-h-60 w-full overflow-auto rounded-prominent bg-white py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm";

  if (searchable) {
    return (
      <div className={`flex flex-col gap-1 ${className}`}>
        {label && (
          <label htmlFor={controlId} className="text-foreground-primary text-base lg:text-lg">
            {label}
          </label>
        )}
        <Combobox
          value={value ?? null}
          onChange={(nextValue) => {
            if (nextValue) onChange(nextValue);
          }}
          disabled={isLoading}
          by="id"
          onClose={() => setQuery("")}
        >
          <div className="relative">
            <Combobox.Input
              id={controlId}
              aria-invalid={Boolean(error)}
              className={classNames(controlClassName, "pl-10 text-neutral-600")}
              displayValue={(option: Option | null) => option?.name ?? ""}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isLoading ? "در حال بارگیری..." : searchPlaceholder || placeholder}
              autoComplete="off"
            />
            <Combobox.Button
              type="button"
              aria-label={label ? `باز کردن فهرست ${label}` : "باز کردن فهرست"}
              className="absolute inset-y-0 left-0 flex items-center px-3"
            >
              {isLoading ? (
                <svg
                  className="h-5 w-5 animate-spin text-gray-400"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              ) : (
                <ArrowDownIcon />
              )}
            </Combobox.Button>

            <Transition
              as={Fragment}
              leave="transition-opacity duration-100 ease-out"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
              afterLeave={() => setQuery("")}
            >
              <Combobox.Options className={optionsClassName}>
                {filteredOptions.length === 0 ? (
                  <div className="relative cursor-default select-none px-4 py-2 text-gray-500">
                    {emptyMessage}
                  </div>
                ) : (
                  filteredOptions.map((option) => (
                    <Combobox.Option
                      key={option.id}
                      value={option}
                      className={({ focus }) =>
                        `relative cursor-pointer select-none px-4 py-2 text-gray-900 ${
                          focus ? "bg-primary-50" : ""
                        }`
                      }
                    >
                      {({ selected }) => (
                        <span
                          className={`block truncate ${selected ? "font-medium" : "font-normal"}`}
                        >
                          {option.name}
                        </span>
                      )}
                    </Combobox.Option>
                  ))
                )}
              </Combobox.Options>
            </Transition>
          </div>
        </Combobox>
        {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {label && <label className="text-foreground-primary text-base lg:text-lg">{label}</label>}
      <Listbox value={value ?? null} onChange={onChange} disabled={isLoading} by="id">
        <div className="relative">
          <Listbox.Button
            className={controlClassName}
          >
            <span className="block truncate text-neutral-600">
              {isLoading ? "در حال بارگیری..." : value?.name || placeholder}
            </span>
            <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2">
              {isLoading ? (
                <svg
                  className="h-5 w-5 animate-spin text-gray-400"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              ) : (
                <ArrowDownIcon />
              )}
            </span>
          </Listbox.Button>

          {error && <p className="mt-1 text-sm text-red-500">{error}</p>}

          <Transition
            as={Fragment}
            leave="transition-opacity duration-100 ease-out"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <Listbox.Options className={optionsClassName}>
              {options.length === 0 ? (
                <div className="relative cursor-default select-none px-4 py-2 text-gray-500">
                  {emptyMessage}
                </div>
              ) : (
                options.map((option) => (
                  <Listbox.Option
                    key={option.id}
                    value={option}
                    className={({ active }) =>
                      `relative cursor-pointer select-none px-4 py-2 text-gray-900 ${
                        active ? "bg-primary-50" : ""
                      }`
                    }
                  >
                    {({ selected }) => (
                      <span
                        className={`block truncate ${selected ? "font-medium" : "font-normal"}`}
                      >
                        {option.name}
                      </span>
                    )}
                  </Listbox.Option>
                ))
              )}
            </Listbox.Options>
          </Transition>
        </div>
      </Listbox>
    </div>
  );
}
