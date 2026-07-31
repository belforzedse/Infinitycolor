import ChevronLeftIcon from "./Icons/ChevronLeftIcon";
import ChevronRightIcon from "./Icons/ChevronRightIcon";

type Props = {
  goToNextImage: () => void;
  goToPreviousImage: () => void;
  nextDisabled?: boolean;
  previousDisabled?: boolean;
  nextLabel?: string;
  previousLabel?: string;
};

export default function PDPHeroNavigationButtons(props: Props) {
  const {
    goToNextImage,
    goToPreviousImage,
    nextDisabled = false,
    previousDisabled = false,
    nextLabel = "تصویر بعدی",
    previousLabel = "تصویر قبلی",
  } = props;

  return (
    <div className="flex gap-3">
      <button
        type="button"
        aria-label={nextLabel}
        disabled={nextDisabled}
        className="pressable z-10 flex h-8 w-8 items-center justify-center rounded-full border border-infinity-primary-lighter/60 bg-white text-neutral-700 transition-colors hover:bg-infinity-primary-lighter/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-40"
        onClick={goToNextImage}
      >
        <ChevronRightIcon />
      </button>

      <button
        type="button"
        aria-label={previousLabel}
        disabled={previousDisabled}
        className="pressable z-10 flex h-8 w-8 items-center justify-center rounded-full border border-infinity-primary-lighter/60 bg-white text-neutral-700 transition-colors hover:bg-infinity-primary-lighter/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-40"
        onClick={goToPreviousImage}
      >
        <ChevronLeftIcon />
      </button>
    </div>
  );
}
