"use client";

import { apiClient } from "@/services";
import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";

type ShippingRule = {
  id?: string;
  title?: string;
  active: boolean;
  priority: number;
  price?: number | null;
  freeShippingThreshold?: number | null;
  minSubtotal?: number | null;
  maxSubtotal?: number | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  minWeight?: number | null;
  maxWeight?: number | null;
  provinceIds: number[];
  cityIds: number[];
  productIds: number[];
  categoryIds: number[];
  roleTypes: string[];
};

type ShippingFormState = {
  Title: string;
  Code: string;
  Price: number;
  SortOrder: number;
  Description: string;
  EstimatedDeliveryText: string;
  IsActive: boolean;
  Rules: ShippingRule[];
};

type Props = {
  mode: "add" | "edit";
  id?: string;
};

const ROLE_OPTIONS = [
  { value: "customer", label: "مشتری" },
  { value: "store-manager", label: "مدیر فروشگاه" },
  { value: "founder", label: "موسس" },
  { value: "superadmin", label: "سوپرادمین" },
];

const emptyRule = (): ShippingRule => ({
  id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  title: "",
  active: true,
  priority: 0,
  price: null,
  freeShippingThreshold: null,
  minSubtotal: null,
  maxSubtotal: null,
  minQuantity: null,
  maxQuantity: null,
  minWeight: null,
  maxWeight: null,
  provinceIds: [],
  cityIds: [],
  productIds: [],
  categoryIds: [],
  roleTypes: [],
});

const initialState: ShippingFormState = {
  Title: "",
  Code: "",
  Price: 0,
  SortOrder: 0,
  Description: "",
  EstimatedDeliveryText: "",
  IsActive: true,
  Rules: [],
};

const numberOrNull = (value: unknown) => {
  if (value === "" || value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const getResponseData = (response: any) => response?.data?.data || response?.data || response;

function Field({
  label,
  children,
  error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-infinity-primary ${props.className || ""}`}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`min-h-24 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-infinity-primary ${props.className || ""}`}
    />
  );
}

function EntitySelector({
  label,
  endpoint,
  value,
  onChange,
}: {
  label: string;
  endpoint: string;
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Array<{ id: number; title: string }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const titleFilter = query.trim()
          ? `&filters[Title][$containsi]=${encodeURIComponent(query.trim())}`
          : "";
        const response = await apiClient.get<any>(
          `${endpoint}?pagination[pageSize]=10${titleFilter}`,
        );
        const rows = getResponseData(response);
        const list = Array.isArray(rows)
          ? rows
          : Array.isArray(rows?.data)
            ? rows.data
            : [];
        if (!cancelled) {
          setOptions(
            list.map((item: any) => ({
              id: Number(item.id),
              title: item.attributes?.Title || item.Title || item.attributes?.title || `#${item.id}`,
            })),
          );
        }
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const timer = window.setTimeout(run, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [endpoint, query]);

  const selected = value.map((id) => options.find((item) => item.id === id) || { id, title: `#${id}` });

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        {loading && <span className="text-xs text-slate-400">در حال جستجو...</span>}
      </div>
      <TextInput
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="جستجو"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() =>
              onChange(value.includes(option.id) ? value : [...value, option.id])
            }
            className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200"
          >
            {option.title}
          </button>
        ))}
      </div>
      {selected.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {selected.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(value.filter((id) => id !== item.id))}
              className="rounded-full bg-infinity-primary-lighter px-3 py-1 text-xs text-slate-700"
            >
              {item.title} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function validateForm(form: ShippingFormState) {
  const errors: Record<string, string> = {};
  if (!form.Title.trim()) errors.Title = "نام روش ارسال الزامی است";
  if (!form.Code.trim()) errors.Code = "کد داخلی الزامی است";
  if (form.Code && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.Code)) {
    errors.Code = "کد فقط با حروف انگلیسی کوچک، عدد و خط تیره معتبر است";
  }
  if (Number(form.Price) < 0) errors.Price = "هزینه پایه نمی‌تواند منفی باشد";
  if (Number(form.SortOrder) < 0) errors.SortOrder = "ترتیب نمی‌تواند منفی باشد";

  form.Rules.forEach((rule, index) => {
    const prefix = `قانون ${index + 1}`;
    const ranges: Array<[keyof ShippingRule, keyof ShippingRule, string]> = [
      ["minSubtotal", "maxSubtotal", "مبلغ سفارش"],
      ["minQuantity", "maxQuantity", "تعداد"],
      ["minWeight", "maxWeight", "وزن"],
    ];
    if (numberOrNull(rule.price) !== null && Number(rule.price) < 0) {
      errors[`rule-${index}`] = `${prefix}: قیمت نمی‌تواند منفی باشد`;
    }
    if (
      numberOrNull(rule.freeShippingThreshold) !== null &&
      Number(rule.freeShippingThreshold) < 0
    ) {
      errors[`rule-${index}`] = `${prefix}: آستانه ارسال رایگان نمی‌تواند منفی باشد`;
    }
    for (const [minKey, maxKey, label] of ranges) {
      const min = numberOrNull(rule[minKey]);
      const max = numberOrNull(rule[maxKey]);
      if (min !== null && min < 0) errors[`rule-${index}`] = `${prefix}: حداقل ${label} منفی است`;
      if (max !== null && max < 0) errors[`rule-${index}`] = `${prefix}: حداکثر ${label} منفی است`;
      if (min !== null && max !== null && min > max) {
        errors[`rule-${index}`] = `${prefix}: حداقل ${label} از حداکثر بیشتر است`;
      }
    }
  });

  return errors;
}

export default function ShippingMethodForm({ mode, id }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<ShippingFormState>(initialState);
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (mode !== "edit" || !id) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const response = await apiClient.get<any>(`/shippings/${id}?populate[Icon]=true`);
        const item = getResponseData(response);
        const attrs = item?.attributes || item || {};
        if (!cancelled) {
          setForm({
            Title: attrs.Title || "",
            Code: attrs.Code || "",
            Price: Number(attrs.Price || 0),
            SortOrder: Number(attrs.SortOrder || 0),
            Description: attrs.Description || "",
            EstimatedDeliveryText: attrs.EstimatedDeliveryText || "",
            IsActive: attrs.IsActive !== false,
            Rules: Array.isArray(attrs.Rules) ? attrs.Rules.map((rule: any) => ({ ...emptyRule(), ...rule })) : [],
          });
        }
      } catch {
        toast.error("خطا در دریافت روش ارسال");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [id, mode]);

  const validationErrors = useMemo(() => validateForm(form), [form]);

  const updateRule = (index: number, patch: Partial<ShippingRule>) => {
    setForm((prev) => ({
      ...prev,
      Rules: prev.Rules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...patch } : rule,
      ),
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextErrors = validateForm(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const payload = {
        data: {
          Title: form.Title.trim(),
          Code: form.Code.trim(),
          Price: Math.round(Number(form.Price || 0)),
          SortOrder: Math.round(Number(form.SortOrder || 0)),
          Description: form.Description.trim() || null,
          EstimatedDeliveryText: form.EstimatedDeliveryText.trim() || null,
          IsActive: form.IsActive,
          Rules: form.Rules.map((rule) => ({
            ...rule,
            priority: Number(rule.priority || 0),
            price: numberOrNull(rule.price),
            freeShippingThreshold: numberOrNull(rule.freeShippingThreshold),
            minSubtotal: numberOrNull(rule.minSubtotal),
            maxSubtotal: numberOrNull(rule.maxSubtotal),
            minQuantity: numberOrNull(rule.minQuantity),
            maxQuantity: numberOrNull(rule.maxQuantity),
            minWeight: numberOrNull(rule.minWeight),
            maxWeight: numberOrNull(rule.maxWeight),
          })),
        },
      };

      if (mode === "edit" && id) {
        await apiClient.put(`/shippings/${id}`, payload);
        toast.success("روش ارسال ویرایش شد");
      } else {
        await apiClient.post("/shippings", payload);
        toast.success("روش ارسال ایجاد شد");
      }
      router.push("/super-admin/shipping");
      router.refresh();
    } catch (error: any) {
      toast.error(error?.message || "خطا در ذخیره روش ارسال");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="rounded-2xl bg-white p-6 text-sm text-slate-500">در حال بارگذاری...</div>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" dir="rtl">
      <div className="rounded-2xl bg-white p-6 shadow-sm">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-800">
            {mode === "edit" ? "ویرایش روش ارسال" : "افزودن روش ارسال"}
          </h1>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.IsActive}
              onChange={(event) => setForm((prev) => ({ ...prev, IsActive: event.target.checked }))}
            />
            فعال
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="نام نمایشی فارسی" error={errors.Title}>
            <TextInput
              value={form.Title}
              onChange={(event) => setForm((prev) => ({ ...prev, Title: event.target.value }))}
            />
          </Field>
          <Field label="کد داخلی" error={errors.Code}>
            <TextInput
              dir="ltr"
              value={form.Code}
              onChange={(event) => setForm((prev) => ({ ...prev, Code: event.target.value }))}
              placeholder="local-courier"
            />
          </Field>
          <Field label="هزینه پایه تومان" error={errors.Price}>
            <TextInput
              type="number"
              min={0}
              value={form.Price}
              onChange={(event) => setForm((prev) => ({ ...prev, Price: Number(event.target.value) }))}
            />
          </Field>
          <Field label="ترتیب نمایش" error={errors.SortOrder}>
            <TextInput
              type="number"
              min={0}
              value={form.SortOrder}
              onChange={(event) => setForm((prev) => ({ ...prev, SortOrder: Number(event.target.value) }))}
            />
          </Field>
          <Field label="زمان تخمینی تحویل">
            <TextInput
              value={form.EstimatedDeliveryText}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, EstimatedDeliveryText: event.target.value }))
              }
            />
          </Field>
          <Field label="توضیحات">
            <TextArea
              value={form.Description}
              onChange={(event) => setForm((prev) => ({ ...prev, Description: event.target.value }))}
            />
          </Field>
        </div>
      </div>

      <div className="rounded-2xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">قوانین قیمت و دسترسی</h2>
            <p className="mt-1 text-sm text-slate-500">
              اگر هیچ قانون فعالی ثبت نشود، روش ارسال برای همه سفارش‌ها با هزینه پایه نمایش داده می‌شود.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setForm((prev) => ({ ...prev, Rules: [...prev.Rules, emptyRule()] }))}
            className="rounded-lg bg-infinity-primary px-4 py-2 text-sm text-white"
          >
            افزودن قانون
          </button>
        </div>

        <div className="space-y-4">
          {form.Rules.map((rule, index) => (
            <div key={rule.id || index} className="rounded-xl border border-slate-200 p-4">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-medium text-slate-800">قانون {index + 1}</span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={rule.active !== false}
                      onChange={(event) => updateRule(index, { active: event.target.checked })}
                    />
                    فعال
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        Rules: prev.Rules.filter((_, ruleIndex) => ruleIndex !== index),
                      }))
                    }
                    className="text-sm text-red-600"
                  >
                    حذف
                  </button>
                </div>
              </div>

              {errors[`rule-${index}`] && (
                <div className="mb-3 rounded-lg bg-red-50 p-2 text-sm text-red-600">
                  {errors[`rule-${index}`]}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Field label="عنوان قانون">
                  <TextInput
                    value={rule.title || ""}
                    onChange={(event) => updateRule(index, { title: event.target.value })}
                  />
                </Field>
                <Field label="اولویت">
                  <TextInput
                    type="number"
                    value={rule.priority}
                    onChange={(event) => updateRule(index, { priority: Number(event.target.value) })}
                  />
                </Field>
                <Field label="قیمت جایگزین">
                  <TextInput
                    type="number"
                    min={0}
                    value={rule.price ?? ""}
                    onChange={(event) => updateRule(index, { price: numberOrNull(event.target.value) })}
                  />
                </Field>
                <Field label="ارسال رایگان از مبلغ">
                  <TextInput
                    type="number"
                    min={0}
                    value={rule.freeShippingThreshold ?? ""}
                    onChange={(event) =>
                      updateRule(index, { freeShippingThreshold: numberOrNull(event.target.value) })
                    }
                  />
                </Field>
                <Field label="حداقل مبلغ سفارش">
                  <TextInput
                    type="number"
                    min={0}
                    value={rule.minSubtotal ?? ""}
                    onChange={(event) => updateRule(index, { minSubtotal: numberOrNull(event.target.value) })}
                  />
                </Field>
                <Field label="حداکثر مبلغ سفارش">
                  <TextInput
                    type="number"
                    min={0}
                    value={rule.maxSubtotal ?? ""}
                    onChange={(event) => updateRule(index, { maxSubtotal: numberOrNull(event.target.value) })}
                  />
                </Field>
                <Field label="حداقل تعداد">
                  <TextInput
                    type="number"
                    min={0}
                    value={rule.minQuantity ?? ""}
                    onChange={(event) => updateRule(index, { minQuantity: numberOrNull(event.target.value) })}
                  />
                </Field>
                <Field label="حداکثر تعداد">
                  <TextInput
                    type="number"
                    min={0}
                    value={rule.maxQuantity ?? ""}
                    onChange={(event) => updateRule(index, { maxQuantity: numberOrNull(event.target.value) })}
                  />
                </Field>
                <Field label="حداقل وزن گرم">
                  <TextInput
                    type="number"
                    min={0}
                    value={rule.minWeight ?? ""}
                    onChange={(event) => updateRule(index, { minWeight: numberOrNull(event.target.value) })}
                  />
                </Field>
                <Field label="حداکثر وزن گرم">
                  <TextInput
                    type="number"
                    min={0}
                    value={rule.maxWeight ?? ""}
                    onChange={(event) => updateRule(index, { maxWeight: numberOrNull(event.target.value) })}
                  />
                </Field>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <EntitySelector
                  label="استان‌های مجاز"
                  endpoint="/shipping-provinces"
                  value={rule.provinceIds}
                  onChange={(provinceIds) => updateRule(index, { provinceIds })}
                />
                <EntitySelector
                  label="شهرهای مجاز"
                  endpoint="/shipping-cities"
                  value={rule.cityIds}
                  onChange={(cityIds) => updateRule(index, { cityIds })}
                />
                <EntitySelector
                  label="محصولات مجاز"
                  endpoint="/products"
                  value={rule.productIds}
                  onChange={(productIds) => updateRule(index, { productIds })}
                />
                <EntitySelector
                  label="دسته‌بندی‌های مجاز"
                  endpoint="/product-categories"
                  value={rule.categoryIds}
                  onChange={(categoryIds) => updateRule(index, { categoryIds })}
                />
              </div>

              <div className="mt-4 rounded-lg border border-slate-200 p-3">
                <span className="mb-2 block text-sm font-medium text-slate-700">نقش‌های مجاز</span>
                <div className="flex flex-wrap gap-3">
                  {ROLE_OPTIONS.map((role) => (
                    <label key={role.value} className="flex items-center gap-2 text-sm text-slate-600">
                      <input
                        type="checkbox"
                        checked={rule.roleTypes.includes(role.value)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...rule.roleTypes, role.value]
                            : rule.roleTypes.filter((item) => item !== role.value);
                          updateRule(index, { roleTypes: next });
                        }}
                      />
                      {role.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ))}

          {form.Rules.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
              هنوز قانونی ثبت نشده است.
            </div>
          )}
        </div>
      </div>

      <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-xl bg-white p-4 shadow-sm">
        <button
          type="button"
          onClick={() => router.push("/super-admin/shipping")}
          className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-700"
        >
          انصراف
        </button>
        <button
          type="submit"
          disabled={saving || Object.keys(validationErrors).length > 0}
          className="rounded-lg bg-infinity-primary px-5 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "در حال ذخیره..." : "ذخیره"}
        </button>
      </div>
    </form>
  );
}
