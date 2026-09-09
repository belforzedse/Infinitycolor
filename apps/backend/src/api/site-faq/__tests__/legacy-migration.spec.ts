import {
  mapLegacyFaqCategories,
  siteFaqHasQuestions,
} from "../lib/legacy-migration";

describe("legacy FAQ to site-faq mapping", () => {
  it("maps collection-type categories and preserves source order when Order is zero", () => {
    const mapped = mapLegacyFaqCategories([
      {
        Title: "کلی",
        Description: null,
        Order: 0,
        faq_questions: [
          {
            Question: "سفارش‌ها به چه شکل ارسال می‌شوند؟",
            Answer: "پست پیشتاز",
            Order: 0,
            IsActive: true,
          },
          {
            Question: "امکان تعویض وجود دارد؟",
            Answer: "بله",
            Order: 0,
            IsActive: true,
          },
        ],
      },
    ]);

    expect(mapped).toEqual([
      {
        title: "کلی",
        description: undefined,
        order: 0,
        items: [
          {
            question: "سفارش‌ها به چه شکل ارسال می‌شوند؟",
            answer: "پست پیشتاز",
            order: 0,
            isActive: true,
          },
          {
            question: "امکان تعویض وجود دارد؟",
            answer: "بله",
            order: 1,
            isActive: true,
          },
        ],
      },
    ]);
  });

  it("treats an empty site-faq as needing migration", () => {
    expect(siteFaqHasQuestions([])).toBe(false);
    expect(siteFaqHasQuestions([{ title: "کلی", items: [] }])).toBe(false);
    expect(
      siteFaqHasQuestions([
        { title: "کلی", items: [{ question: "سوال", answer: "پاسخ" }] },
      ]),
    ).toBe(true);
  });
});
