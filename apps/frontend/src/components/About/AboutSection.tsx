import React from "react";

interface AboutSectionProps {
  title: string;
  children: React.ReactNode;
  className?: string;
  titleAs?: "h1" | "h2";
}

export default function AboutSection({
  title,
  children,
  className = "",
  titleAs = "h2",
}: AboutSectionProps) {
  const TitleTag = titleAs;

  return (
    <section className={`space-y-4 ${className}`}>
      <div className="flex items-start gap-3">
        <div className="h-12 w-1 flex-shrink-0 rounded-full bg-infinity-primary" />
        <TitleTag className="text-foreground-primary text-2xl font-semibold lg:text-3xl">
          {title}
        </TitleTag>
      </div>
      <div className="pr-4 text-base leading-relaxed text-neutral-700 lg:text-lg">
        {children}
      </div>
    </section>
  );
}
