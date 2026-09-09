import PaginationDesktop from "./PaginationDesktop";

type HeroBannerPaginationProps = {
  total: number;
  index: number;
  onDotClick: (i: number) => void;
  onNext: () => void;
  onPrev: () => void;
  className: string;
};

export default function HeroBannerPagination({
  total,
  index,
  onDotClick,
  onNext,
  onPrev,
  className,
}: HeroBannerPaginationProps) {
  return (
    <div
      className="mt-2 flex justify-center lg:pointer-events-none lg:absolute lg:inset-x-0 lg:bottom-4 lg:mt-0"
      data-hero-pagination=""
    >
      <PaginationDesktop
        total={total}
        index={index}
        onDotClick={onDotClick}
        onNext={onNext}
        onPrev={onPrev}
        className={className}
        arrowClassName="text-[#623E29]"
        dotClassName="bg-[#623E29]/25"
        dotActiveClassName="bg-[#623E29]/70"
      />
    </div>
  );
}
