import type { GenericAttributeSelector } from "@/services/product/product";

type Props = {
  selectors: GenericAttributeSelector[];
  selection: Record<string, string>;
  disabledTermIds: Set<string>;
  onChange: (attributeId: string, termId: string) => void;
};

const validHex = (value?: string | null) =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export default function GenericAttributes({
  selectors,
  selection,
  disabledTermIds,
  onChange,
}: Props) {
  if (selectors.length === 0) return null;

  return (
    <div className="flex flex-col gap-6" data-testid="generic-attribute-selectors">
      {selectors.map((selector) => (
        <section key={selector.attributeId} className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-neutral-800">{selector.title}</h3>
            <span className="text-xs text-neutral-500">
              {selector.options.find(
                (option) => option.id === selection[String(selector.attributeId)],
              )?.title || ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {selector.options.map((option) => {
              const selected = selection[String(selector.attributeId)] === option.id;
              const disabled = disabledTermIds.has(option.id);
              const showSwatch = selector.type === "Color" && validHex(option.colorCode);

              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() => onChange(String(selector.attributeId), option.id)}
                  className={[
                    "inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-sm transition",
                    selected
                      ? "border-infinity-primary bg-infinity-primary-lighter/20 text-infinity-primary-dark"
                      : "border-slate-200 bg-white text-neutral-700 hover:border-infinity-primary-lighter",
                    disabled ? "cursor-not-allowed opacity-40" : "",
                  ].join(" ")}
                >
                  {showSwatch && (
                    <span
                      className="h-5 w-5 rounded-full border border-black/10"
                      style={{ backgroundColor: option.colorCode || undefined }}
                      aria-hidden="true"
                    />
                  )}
                  <span>{option.title}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
