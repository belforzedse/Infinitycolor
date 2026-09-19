"use client";
import { useState } from "react";
import AttributeChip from "./AttributeChip";
import ColorOptionCard, { isValidHex } from "./ColorOptionCard";

type Props = {
  colors: {
    id: string;
    title: string;
    colorCode: string | null | undefined;
  }[];
  onColorChange?: (colorId: string) => void;
  selectedColor?: string;
  disabledColorIds?: string[];
};

export default function PDPHeroInfoColor(props: Props) {
  const {
    colors,
    onColorChange,
    selectedColor: externalSelectedColor,
    disabledColorIds = [],
  } = props;

  const [internalSelectedColor, setInternalSelectedColor] = useState<string>(colors[0]?.id || "");

  const selectedColor =
    externalSelectedColor !== undefined ? externalSelectedColor : internalSelectedColor;

  const handleColorClick = (colorId: string) => {
    setInternalSelectedColor(colorId);
    if (onColorChange) {
      onColorChange(colorId);
    }
  };

  /**
   * Plenty of catalogue colours were imported without a hex code. A grid of blank
   * boxes says less than the names alone, so a section with nothing to paint falls
   * back to name chips; a section with any hex keeps the swatch cards.
   */
  const hasAnySwatch = colors.some((color) => isValidHex(color.colorCode));

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xl text-neutral-800">انتخاب رنگ</span>

      <div
        className="flex flex-wrap items-center gap-2"
        role="radiogroup"
        aria-label="انتخاب رنگ محصول"
      >
        {colors.map((color) => {
          const isSelected = color.id === selectedColor;
          const isDisabled = disabledColorIds.includes(color.id);
          const ariaLabel = isDisabled
            ? `رنگ ${color.title} ناموجود`
            : `انتخاب رنگ ${color.title}`;
          const dataProps = {
            "data-testid": "pdp-color-option",
            "data-color-id": color.id,
            "data-color-title": color.title,
            "data-color-code": color.colorCode || "",
          };

          if (!hasAnySwatch) {
            return (
              <AttributeChip
                key={color.id}
                title={color.title}
                selected={isSelected}
                disabled={isDisabled}
                onClick={() => handleColorClick(color.id)}
                ariaLabel={ariaLabel}
                dataProps={dataProps}
              />
            );
          }

          return (
            <ColorOptionCard
              key={color.id}
              title={color.title}
              colorCode={color.colorCode}
              selected={isSelected}
              disabled={isDisabled}
              onClick={() => handleColorClick(color.id)}
              ariaLabel={ariaLabel}
              dataProps={dataProps}
            />
          );
        })}
      </div>
    </div>
  );
}
