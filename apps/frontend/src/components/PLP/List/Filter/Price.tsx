"use client";

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { normalizeDigits } from "@/utils/faNum";

// TODO: Evaluate using a lighter range slider or native `<input type="range">`
const Slider = dynamic(() => import("rc-slider"), { ssr: false });

interface PriceFilterProps {
  minPrice?: number;
  maxPrice?: number;
  minPriceValue?: number;
  maxPriceValue?: number;
  onPriceChange?: (min: number, max: number) => void;
  /** Debounce before committing typed/slider changes upstream (ms). */
  commitDelayMs?: number;
}

function formatPrice(price: number) {
  return price.toLocaleString("fa-IR");
}

/** Parse a possibly fa-IR / Arabic-digit formatted string to a number, or null if empty/invalid. */
function parsePrice(value: string): number | null {
  const digits = normalizeDigits(value).replace(/[^0-9]/g, "");
  if (digits === "") return null;
  const n = parseInt(digits, 10);
  return Number.isNaN(n) ? null : n;
}

const PriceFilter = ({
  minPrice = 200000,
  maxPrice = 500000,
  minPriceValue,
  maxPriceValue,
  onPriceChange,
  commitDelayMs = 500,
}: PriceFilterProps) => {
  const [priceRange, setPriceRange] = useState<[number, number]>([
    minPriceValue ?? minPrice,
    maxPriceValue ?? maxPrice,
  ]);
  const [inputValues, setInputValues] = useState({
    min: formatPrice(minPriceValue ?? minPrice),
    max: formatPrice(maxPriceValue ?? maxPrice),
  });

  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingRef = useRef(false);
  const onPriceChangeRef = useRef(onPriceChange);
  onPriceChangeRef.current = onPriceChange;

  useEffect(() => {
    import("rc-slider/assets/index.css");
  }, []);

  // Sync from external (URL) values — but never clobber the field while the user is typing.
  useEffect(() => {
    if (editingRef.current) return;
    const nextMin = minPriceValue ?? minPrice;
    const nextMax = maxPriceValue ?? maxPrice;
    setPriceRange([nextMin, nextMax]);
    setInputValues({ min: formatPrice(nextMin), max: formatPrice(nextMax) });
  }, [minPriceValue, maxPriceValue, minPrice, maxPrice]);

  useEffect(() => {
    return () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    };
  }, []);

  /** Clamp both ends to bounds and ensure min <= max (used only on commit). */
  const clampRange = useCallback(
    (min: number, max: number): [number, number] => {
      let lo = Math.min(Math.max(min, minPrice), maxPrice);
      let hi = Math.min(Math.max(max, minPrice), maxPrice);
      if (lo > hi) [lo, hi] = [hi, lo];
      return [lo, hi];
    },
    [minPrice, maxPrice],
  );

  const scheduleCommit = useCallback(
    (min: number, max: number) => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(() => onPriceChangeRef.current?.(min, max), commitDelayMs);
    },
    [commitDelayMs],
  );

  const handleSliderChange = (value: number | number[]) => {
    if (!Array.isArray(value)) return;
    const [lo, hi] = clampRange(value[0], value[1]);
    setPriceRange([lo, hi]);
    setInputValues({ min: formatPrice(lo), max: formatPrice(hi) });
    scheduleCommit(lo, hi);
  };

  const handleInputChange = (raw: string, isMin: boolean) => {
    // Keep exactly what the user typed so the caret doesn't jump; parse leniently.
    setInputValues((prev) => (isMin ? { ...prev, min: raw } : { ...prev, max: raw }));
    const parsed = parsePrice(raw);
    if (parsed === null) return; // empty/invalid while typing — wait for more input or blur

    // Reflect on the slider without clamping against the other handle mid-typing.
    setPriceRange((prev) => (isMin ? [parsed, prev[1]] : [prev[0], parsed]));
    const next = isMin ? clampRange(parsed, priceRange[1]) : clampRange(priceRange[0], parsed);
    scheduleCommit(next[0], next[1]);
  };

  /** Normalize, clamp, reformat and commit immediately (on blur / Enter). */
  const commitInput = () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    const lo = parsePrice(inputValues.min) ?? minPrice;
    const hi = parsePrice(inputValues.max) ?? maxPrice;
    const [clo, chi] = clampRange(lo, hi);
    setPriceRange([clo, chi]);
    setInputValues({ min: formatPrice(clo), max: formatPrice(chi) });
    onPriceChangeRef.current?.(clo, chi);
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editingRef.current = false;
      commitInput();
      e.currentTarget.blur();
    }
  };

  // rc-slider needs each handle within [minPrice, maxPrice]; ordering handled by allowCross={false}.
  const sliderValue: [number, number] = [
    Math.min(Math.max(priceRange[0], minPrice), maxPrice),
    Math.min(Math.max(priceRange[1], minPrice), maxPrice),
  ];

  return (
    <div className="flex w-full flex-col gap-y-8">
      <div className="flex flex-col gap-y-4">
        <div className="flex flex-row-reverse items-center justify-between gap-1">
          <div className="w-[92px] rounded-lg border border-slate-200 bg-white py-1">
            <input
              type="text"
              inputMode="numeric"
              value={inputValues.max}
              placeholder={`${formatPrice(maxPrice)} تومان`}
              onFocus={() => {
                editingRef.current = true;
              }}
              onChange={(e) => handleInputChange(e.target.value, false)}
              onBlur={() => {
                editingRef.current = false;
                commitInput();
              }}
              onKeyDown={handleInputKeyDown}
              className="text-xs w-full text-center text-neutral-400 focus:outline-none"
            />
          </div>
          <span className="text-xs text-neutral-800">تا</span>
          <div className="w-[92px] rounded-lg border border-slate-200 bg-white py-1">
            <input
              type="text"
              inputMode="numeric"
              value={inputValues.min}
              placeholder={`${formatPrice(minPrice)} تومان`}
              onFocus={() => {
                editingRef.current = true;
              }}
              onChange={(e) => handleInputChange(e.target.value, true)}
              onBlur={() => {
                editingRef.current = false;
                commitInput();
              }}
              onKeyDown={handleInputKeyDown}
              className="text-xs w-full text-center text-neutral-400 focus:outline-none"
            />
          </div>
          <span className="text-xs text-neutral-800">شروع از</span>
        </div>

        <div className="px-1.5 py-4">
          <Slider
            range
            min={minPrice}
            max={maxPrice}
            step={1000}
            value={sliderValue}
            onChange={handleSliderChange}
            reverse
            pushable={20000}
            allowCross={false}
            railStyle={{ backgroundColor: "#EAEDF0", height: 2 }}
            trackStyle={[{ backgroundColor: "#090909", height: 2 }]}
            handleStyle={[
              {
                backgroundColor: "#090909",
                border: "2px solid white",
                boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
                opacity: 1,
                width: 12,
                height: 12,
                marginTop: -5,
                zIndex: 1,
              },
              {
                backgroundColor: "#090909",
                border: "2px solid white",
                boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
                opacity: 1,
                width: 12,
                height: 12,
                marginTop: -5,
                zIndex: 2,
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
};

export default PriceFilter;
