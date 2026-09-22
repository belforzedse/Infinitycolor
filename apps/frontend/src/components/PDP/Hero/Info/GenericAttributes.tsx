"use client";

import type { GenericAttributeSelector } from "@/services/product/product";
import AttributeChip from "./AttributeChip";
import ColorOptionCard, { isValidHex } from "./ColorOptionCard";

type Props = {
  selectors: GenericAttributeSelector[];
  selection: Record<string, string>;
  disabledTermIds: Set<string>;
  onChange: (attributeId: string, termId: string) => void;
};

export default function GenericAttributes({
  selectors,
  selection,
  disabledTermIds,
  onChange,
}: Props) {
  if (selectors.length === 0) return null;

  return (
    <div className="flex flex-col gap-6" data-testid="generic-attribute-selectors">
      {selectors.map((selector) => {
        const isColorAttribute = selector.type === "Color";
        /**
         * A Color-typed attribute whose terms never got hex codes has nothing to
         * paint, so it renders as name chips rather than a row of blank boxes. The
         * heading still follows the attribute's type, not what the data happens to
         * carry, so a missing hex never restyles the section around it.
         */
        const showSwatchCards =
          isColorAttribute && selector.options.some((option) => isValidHex(option.colorCode));

        return (
          <section key={selector.attributeId} className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className={isColorAttribute ? "text-xl text-neutral-800" : "text-sm font-medium text-neutral-800"}>
                {selector.title}
              </h3>
              {!isColorAttribute && (
                <span className="text-xs text-neutral-500">
                  {selector.options.find(
                    (option) => option.id === selection[String(selector.attributeId)],
                  )?.title || ""}
                </span>
              )}
            </div>

            {/* Terms wrap onto extra rows; nothing is parked off-screen behind a sideways scroll. */}
            <div className="flex flex-wrap items-center gap-2">
              {selector.options.map((option) => {
                const selected = selection[String(selector.attributeId)] === option.id;
                const disabled = disabledTermIds.has(option.id);
                // The other pickers (Size/Color/Model) already spell the
                // disabled reason out loud; without this a screen reader gets
                // only "disabled" and no idea the option is out of stock.
                const label = disabled ? `${option.title} ناموجود` : option.title;

                if (showSwatchCards) {
                  return (
                    <ColorOptionCard
                      key={option.id}
                      title={option.title}
                      colorCode={option.colorCode}
                      selected={selected}
                      disabled={disabled}
                      onClick={() => onChange(String(selector.attributeId), option.id)}
                      ariaLabel={label}
                      dataProps={{
                        "data-testid": "pdp-generic-color-option",
                        "data-term-id": option.id,
                        "data-term-title": option.title,
                        "data-term-code": option.colorCode || "",
                      }}
                    />
                  );
                }

                return (
                  <AttributeChip
                    key={option.id}
                    title={option.title}
                    selected={selected}
                    disabled={disabled}
                    onClick={() => onChange(String(selector.attributeId), option.id)}
                    ariaLabel={label}
                    dataProps={{
                      "data-testid": "pdp-generic-option",
                      "data-term-id": option.id,
                      "data-term-title": option.title,
                    }}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
