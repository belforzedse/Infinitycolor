import type { GenericAttributeSelector } from "@/services/product/product";

interface QuickViewVariationSelectorProps {
  colors: Array<{ title: string; colorCode: string }>;
  sizes: Array<{ title: string }>;
  effectiveColorCode: string | null;
  effectiveSizeTitle: string | null;
  availableSizesForColor: Set<string>;
  onSelectColor: (colorCode: string) => void;
  onSelectSize: (sizeTitle: string) => void;
  genericSelectors: GenericAttributeSelector[];
  genericSelection: Record<string, string>;
  availableGenericTermIds: Set<string>;
  onSelectGeneric: (attributeId: string, termId: string) => void;
}

export default function QuickViewVariationSelector({
  colors,
  sizes,
  effectiveColorCode,
  effectiveSizeTitle,
  availableSizesForColor,
  onSelectColor,
  onSelectSize,
  genericSelectors,
  genericSelection,
  availableGenericTermIds,
  onSelectGeneric,
}: QuickViewVariationSelectorProps) {
  return (
    <div className="space-y-4">
      {/* Colors */}
      {colors.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-800">رنگ</h3>
            <span className="text-xs text-gray-500">
              {colors.find((c) => c.colorCode === effectiveColorCode)?.title ?? ""}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {colors.map((color) => {
              const active = color.colorCode === effectiveColorCode;
              return (
                <button
                  key={color.colorCode}
                  type="button"
                  onClick={() => onSelectColor(color.colorCode)}
                  title={color.title}
                  aria-pressed={active}
                  className={[
                    "relative h-10 w-10 rounded-full ring-1 transition",
                    active ? "ring-infinity-primary" : "ring-black/10 hover:ring-infinity-primary-lighter",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary",
                  ].join(" ")}
                  style={{ backgroundColor: color.colorCode }}
                >
                  <span className="sr-only">{color.title}</span>
                  {active && (
                    <span className="absolute inset-0 grid place-items-center">
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-white/80 text-gray-900 ring-1 ring-black/10">
                        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                          <path
                            fillRule="evenodd"
                            d="M16.704 5.29a1 1 0 010 1.414l-7.5 7.5a1 1 0 01-1.414 0l-3.5-3.5a1 1 0 011.414-1.414l2.793 2.793 6.793-6.793a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Sizes */}
      {sizes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-800">سایز</h3>
          <div className="flex flex-wrap gap-2">
            {sizes.map((size) => {
              const active = size.title === effectiveSizeTitle;
              const disabled = !availableSizesForColor.has(size.title);

              return (
                <button
                  key={size.title}
                  type="button"
                  onClick={() => {
                    if (!disabled) {
                      onSelectSize(size.title);
                    }
                  }}
                  aria-pressed={active}
                  disabled={disabled}
                  className={[
                    "rounded-2xl px-4 py-2 text-sm ring-1 transition",
                    active
                      ? "bg-infinity-primary-lighter/20 text-infinity-primary-dark ring-infinity-primary-lighter/60"
                      : "bg-white text-gray-700 ring-black/10 hover:bg-infinity-primary-lighter/50 hover:ring-infinity-primary-lighter/60",
                    disabled
                      ? "cursor-not-allowed opacity-50 hover:bg-white hover:ring-black/10"
                      : "",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary",
                  ].join(" ")}
                >
                  {size.title}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {genericSelectors.map((selector) => (
        <div key={selector.attributeId} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-800">{selector.title}</h3>
            <span className="text-xs text-gray-500">
              {selector.options.find(
                (option) => option.id === genericSelection[String(selector.attributeId)],
              )?.title || ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {selector.options.map((option) => {
              const active = genericSelection[String(selector.attributeId)] === option.id;
              const disabled = !availableGenericTermIds.has(option.id);
              const showSwatch =
                selector.type === "Color" &&
                typeof option.colorCode === "string" &&
                /^#[0-9a-f]{6}$/i.test(option.colorCode);
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() => onSelectGeneric(String(selector.attributeId), option.id)}
                  className={[
                    "inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm ring-1 transition",
                    active
                      ? "bg-infinity-primary-lighter/20 text-infinity-primary-dark ring-infinity-primary-lighter/60"
                      : "bg-white text-gray-700 ring-black/10 hover:bg-infinity-primary-lighter/50",
                    disabled ? "cursor-not-allowed opacity-50" : "",
                  ].join(" ")}
                >
                  {showSwatch && (
                    <span
                      className="h-4 w-4 rounded-full border border-black/10"
                      style={{ backgroundColor: option.colorCode || undefined }}
                      aria-hidden="true"
                    />
                  )}
                  {option.title}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
