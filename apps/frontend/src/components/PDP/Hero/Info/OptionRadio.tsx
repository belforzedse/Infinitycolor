/**
 * The selection marker for the non-colour attribute chips (size, model, text terms).
 * Colour terms don't get one — their card already shows what's picked through the
 * swatch border, and a dot on top of a painted swatch only competes with it.
 */
export default function OptionRadio({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
        selected
          ? "border-infinity-primary-darker bg-white"
          : "border-infinity-primary-darker/30 bg-neutral-300"
      }`}
    >
      {selected && <span className="h-2.5 w-2.5 rounded-full bg-infinity-primary-darker" />}
    </span>
  );
}
