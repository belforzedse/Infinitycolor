import { conicGradientFromShades, type ColorShades } from "@/utils/plpColorFilter";

interface FamilyColorSwatchProps {
  shades: ColorShades;
  label: string;
  selected?: boolean;
}

export default function FamilyColorSwatch({ shades, label, selected = false }: FamilyColorSwatchProps) {
  return (
    <span
      role="img"
      aria-hidden="true"
      title={label}
      data-testid="plp-color-swatch"
      data-shades={shades.join(",")}
      className={`relative inline-block h-5 w-5 shrink-0 overflow-hidden rounded-full border border-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.22)] ${
        selected ? "ring-2 ring-infinity-primary ring-offset-1" : ""
      }`}
      style={{ backgroundImage: conicGradientFromShades(shades) }}
    />
  );
}
