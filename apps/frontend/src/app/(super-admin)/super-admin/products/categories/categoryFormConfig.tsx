"use client";

import type { UpsertPageConfigType } from "@/components/SuperAdmin/UpsertPage/ContentWrapper";
import type { categoryResponseType } from "@/services/super-admin/product/category/getAll";
import { getAllCategories } from "@/services/super-admin/product/category/getAll";

export type ProductCategoryForm = {
  id: string;
  Title: string;
  Slug: string;
  Parent: string;
  createdAt: Date;
  updatedAt: Date;
};

type ConfigOptions = {
  mode: "create" | "edit";
  excludeId?: number;
};

const createParentOptionsFetcher =
  (excludeId?: number) =>
  async (searchTerm?: string, formData?: any): Promise<
    Array<{
      label: string;
      value: string;
    }>
  > => {
    try {
      const response = await getAllCategories();

      let categories: categoryResponseType[] = [];

      if (Array.isArray(response)) {
        categories = response;
      } else if (response && typeof response === "object" && "data" in response) {
          const data = (response as any).data;
          if (Array.isArray(data)) {
            categories = data;
          } else if (data && typeof data === 'object' && 'data' in data && Array.isArray(data.data)) {
            categories = data.data;
          }
      }

      if (!Array.isArray(categories) || categories.length === 0) {
        return [];
      }

      const options = categories
        .filter((category) => {
          // Exclude the current category being edited
          if (excludeId && category.id === excludeId) {
            return false;
          }
          // Only include categories that have a valid Title
          if (!category.attributes?.Title) {
            return false;
          }
          return true;
        })
        .map((category) => {
          const label = category.attributes?.Title ?? "-";
          const value = String(category.id); // Ensure it's a string

          return { label, value };
        })
        .filter((opt) => opt.label && opt.value && opt.label !== "-"); // Filter out invalid options

      return options;
    } catch (error) {
      // Log error for debugging but don't show toast
      console.error("Failed to fetch parent categories:", error);
      // Return empty array instead of throwing, so form still loads
      return [];
    }
  };

export const getCategoryFormConfig = (
  options: ConfigOptions,
): UpsertPageConfigType<ProductCategoryForm> => {
  const { mode, excludeId } = options;

  return {
    headTitle: mode === "create" ? "افزودن دسته‌بندی" : "ویرایش دسته‌بندی",
    addButton:
      mode === "edit"
        ? {
            text: "افزودن دسته‌بندی جدید",
            path: "/super-admin/products/categories/add",
          }
        : undefined,
    actionButtons: ({ onSubmit, onCancel, isLoading }) => (
      <>
        <button
          type="button"
          data-testid="admin-category-cancel"
          className="text-sm flex-1 rounded-xl bg-slate-200 px-5 py-2 text-slate-500 md:flex-none"
          onClick={onCancel}
          disabled={isLoading}
        >
          بیخیال شدن
        </button>
        <button
          type="button"
          data-testid="admin-category-save"
          className="text-sm flex-1 rounded-xl bg-actions-primary px-5 py-2 text-white md:flex-none"
          onClick={onSubmit}
          disabled={isLoading}
        >
          {isLoading ? "در حال ذخیره..." : "ذخیره"}
        </button>
      </>
    ),
    config: [
      {
        title: "اطلاعات دسته‌بندی",
        sections: [
          {
            fields: [
              {
                name: "Title",
                type: "text",
                label: "نام",
                colSpan: 12,
                mobileColSpan: 12,
              },
              {
                name: "Slug",
                type: "text",
                label: "نامک",
                colSpan: 12,
                mobileColSpan: 12,
              },
              {
                name: "Parent",
                type: "dropdown",
                label: "دسته والد (اختیاری)",
                colSpan: 12,
                mobileColSpan: 12,
                placeholder: "بدون والد",
                options: [],
                fetchOptions: createParentOptionsFetcher(excludeId),
              },
            ],
          },
        ],
      },
    ],
  };
};

export const createEmptyCategoryFormData = (): ProductCategoryForm => ({
  id: "",
  Title: "",
  Slug: "",
  Parent: "",
  createdAt: new Date(),
  updatedAt: new Date(),
});
