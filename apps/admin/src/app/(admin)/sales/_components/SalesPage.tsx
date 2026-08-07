import { AdminStack } from "@/components/admin";

/**
 * Body wrapper for a Sales subpage.
 *
 * The workspace header, section navigation and reporting period all live in
 * `sales/layout.tsx`, so a subpage only supplies its own heading and content.
 * Previously each of these pages went through `ContentWrapper`, which rendered
 * a second page title under the sidebar's and wrapped already-carded content
 * in another card.
 */
export default function SalesPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section dir="rtl">
      <div className="mb-4 flex min-w-0 flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="min-w-0 break-words text-base font-medium text-slate-800 md:text-lg">
            {title}
          </h2>
          {description && (
            <p className="text-xs text-slate-500">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>
      <AdminStack>{children}</AdminStack>
    </section>
  );
}
