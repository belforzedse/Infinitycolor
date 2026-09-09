"use client";

import type { Dispatch, SetStateAction } from "react";
import type { SiteFaq, SiteFaqCategory, SiteFaqItem } from "@/types/site-identity";
import {
  AddButton,
  Card,
  Field,
  RemoveButton,
  TextArea,
  TextInput,
  Toggle,
} from "./fields";

const newFaqItem = (): SiteFaqItem => ({
  question: "",
  answer: "",
  order: 0,
  isActive: true,
});

const newFaqCategory = (): SiteFaqCategory => ({
  title: "",
  description: "",
  order: 0,
  items: [],
});

export default function FaqEditor({
  faq,
  setFaq,
}: {
  faq: SiteFaq;
  setFaq: Dispatch<SetStateAction<SiteFaq | null>>;
}) {
  const updateCategory = (ci: number, p: Partial<SiteFaqCategory>) =>
    setFaq((prev) =>
      prev
        ? {
            categories: prev.categories.map((c, idx) => (idx === ci ? { ...c, ...p } : c)),
          }
        : prev,
    );

  return (
    <div className="space-y-4">
      {faq.categories.map((category, ci) => (
        <Card key={ci} className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <TextInput
                value={category.title}
                onChange={(v) => updateCategory(ci, { title: v })}
                placeholder="عنوان دسته‌بندی"
              />
            </div>
            <RemoveButton
              onClick={() =>
                setFaq((prev) =>
                  prev ? { categories: prev.categories.filter((_, idx) => idx !== ci) } : prev,
                )
              }
            />
          </div>

          <Field label="توضیحات (اختیاری)">
            <TextInput
              value={category.description ?? ""}
              onChange={(v) => updateCategory(ci, { description: v })}
            />
          </Field>

          <div className="flex flex-col gap-3 border-t border-slate-100 pt-3">
            {category.items.map((item, ii) => (
              <div key={ii} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-slate-500">سوال {ii + 1}</span>
                  <div className="flex items-center gap-3">
                    <Toggle
                      label="فعال"
                      checked={item.isActive !== false}
                      onChange={(v) =>
                        updateCategory(ci, {
                          items: category.items.map((it, idx) =>
                            idx === ii ? { ...it, isActive: v } : it,
                          ),
                        })
                      }
                    />
                    <RemoveButton
                      label=""
                      onClick={() =>
                        updateCategory(ci, {
                          items: category.items.filter((_, idx) => idx !== ii),
                        })
                      }
                    />
                  </div>
                </div>
                <div className="mt-2 flex flex-col gap-2">
                  <TextInput
                    value={item.question}
                    onChange={(v) =>
                      updateCategory(ci, {
                        items: category.items.map((it, idx) =>
                          idx === ii ? { ...it, question: v } : it,
                        ),
                      })
                    }
                    placeholder="سوال"
                  />
                  <TextArea
                    value={item.answer}
                    rows={3}
                    onChange={(v) =>
                      updateCategory(ci, {
                        items: category.items.map((it, idx) =>
                          idx === ii ? { ...it, answer: v } : it,
                        ),
                      })
                    }
                    placeholder="پاسخ (می‌تواند شامل HTML باشد)"
                  />
                </div>
              </div>
            ))}
            <AddButton
              label="افزودن سوال"
              onClick={() => updateCategory(ci, { items: [...category.items, newFaqItem()] })}
            />
          </div>
        </Card>
      ))}
      <AddButton
        label="افزودن دسته‌بندی"
        onClick={() =>
          setFaq((prev) => (prev ? { categories: [...prev.categories, newFaqCategory()] } : prev))
        }
      />
    </div>
  );
}
