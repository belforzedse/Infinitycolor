import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import DOMPurify from "isomorphic-dompurify";

type Props = {
  title: string;
  content: string;
};

export default function PDPHeroInfoFAQItem(props: Props) {
  const { title, content } = props;

  // Check if content contains HTML tags
  const hasHTML = /<[^>]+>/.test(content);

  // Sanitize HTML content if it contains HTML, otherwise use as plain text
  const sanitizedContent = hasHTML ? DOMPurify.sanitize(content) : content;

  return (
    <Disclosure as="div" className="w-full">
      {({ open }) => (
        <>
          <DisclosureButton className="group flex w-full items-center justify-between border-b pb-2 text-right text-neutral-800">
            {title}

            <div>
              <span className="text-lg text-foreground-primary group-data-[open]:hidden">+</span>
              <span className="text-lg hidden text-foreground-primary group-data-[open]:block">-</span>
            </div>
          </DisclosureButton>

          <div
            className="pdp-faq-panel"
            data-state={open ? "open" : "closed"}
          >
            <DisclosurePanel static className="pdp-faq-panel-inner min-h-0 overflow-hidden py-2 text-neutral-500">
              {hasHTML ? (
                <div
                  className="prose prose-sm prose-neutral max-w-none prose-headings:font-semibold prose-p:text-neutral-500 prose-p:leading-relaxed prose-a:text-infinity-primary prose-a:no-underline hover:prose-a:underline"
                  dir="rtl"
                  dangerouslySetInnerHTML={{ __html: sanitizedContent }}
                />
              ) : (
                <div className="text-neutral-500" dir="rtl">
                  {content}
                </div>
              )}
            </DisclosurePanel>
          </div>
        </>
      )}
    </Disclosure>
  );
}
