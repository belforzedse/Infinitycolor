import { contactHref } from "@/utils/identityIcons";
import {
  RETURNS_CLAUSES,
  RETURNS_HEADING,
  RETURNS_INTRO,
  RETURNS_SUPPORT_NUMBER,
  type ReturnPolicyClause,
} from "@/constants/legal";

const SUPPORT_HREF = contactHref({ number: RETURNS_SUPPORT_NUMBER, type: "phone" });

function PolicyParagraph({ text }: { text: string }) {
  if (!SUPPORT_HREF || !text.includes(RETURNS_SUPPORT_NUMBER)) {
    return <p>{text}</p>;
  }

  const [before, after] = text.split(RETURNS_SUPPORT_NUMBER);

  return (
    <p>
      {before}
      <a
        href={SUPPORT_HREF}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-infinity-primary underline underline-offset-2"
      >
        {RETURNS_SUPPORT_NUMBER}
      </a>
      {after}
    </p>
  );
}

function ClauseItem({ clause }: { clause: ReturnPolicyClause }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-infinity-primary text-sm font-semibold text-white">
        {clause.number}
      </span>
      <div className="min-w-0 flex-1 space-y-3 text-base leading-8 text-neutral-700 lg:text-lg">
        {clause.paragraphs.map((paragraph) => (
          <PolicyParagraph key={paragraph} text={paragraph} />
        ))}
        {clause.notice ? (
          <p className="rounded-xl border border-infinity-primary/20 bg-infinity-primary-lighter/20 px-4 py-3 text-sm leading-7 text-neutral-700 lg:text-base">
            {clause.notice}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export default function ReturnPolicyArticle() {
  return (
    <article
      data-testid="return-policy"
      className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 bg-gradient-to-l from-slate-50 via-infinity-primary-lighter/20 to-slate-100 px-5 py-5 md:px-8">
        <p className="text-base leading-8 text-neutral-700 lg:text-lg">{RETURNS_INTRO}</p>
      </div>

      <div className="space-y-6 px-5 py-8 md:px-8">
        <div className="flex items-start gap-3">
          <div className="h-12 w-1 shrink-0 rounded-full bg-infinity-primary" />
          <h2 className="text-foreground-primary text-xl font-semibold lg:text-2xl">
            {RETURNS_HEADING}
          </h2>
        </div>

        <ol className="space-y-6">
          {RETURNS_CLAUSES.map((clause) => (
            <ClauseItem key={clause.number} clause={clause} />
          ))}
        </ol>
      </div>
    </article>
  );
}
