"use client";

import UpsertPageContentWrapper from "@/components/SuperAdmin/UpsertPage/ContentWrapper";
import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import {
  buildCategoryWritePayload,
  createCategory,
} from "@/services/super-admin/product/category/create";
import {
  extractErrorMessage,
  translateErrorMessage,
} from "@/lib/errorTranslations";
import {
  createEmptyCategoryFormData,
  getCategoryFormConfig,
  type ProductCategoryForm,
} from "../categoryFormConfig";
import { useEditorRedirect } from "@/hooks/useEditorRedirect";
import CategoryAppearancePanel, {
  type CategoryImageValue,
} from "../CategoryAppearancePanel";

export default function AddCategoryPage() {
  // Redirect editors away from product pages
  useEditorRedirect();
  const router = useRouter();

  const [categoryImage, setCategoryImage] = useState<
    CategoryImageValue | undefined
  >();
  const [megaMenuImage, setMegaMenuImage] = useState<
    CategoryImageValue | undefined
  >();

  const handleSubmit = async (formData: ProductCategoryForm) => {
    const title = formData.Title?.trim();
    const slug = formData.Slug?.trim();

    if (!title || !slug) {
      toast.error("نام و نامک دسته‌بندی الزامی است");
      return;
    }

    const payload = buildCategoryWritePayload({
      Title: title,
      Slug: slug,
      parentId: formData.Parent,
      Image: categoryImage?.id ?? null,
      MegaMenuImage: megaMenuImage?.id ?? null,
    });

    try {
      await createCategory(payload);
      toast.success("دسته‌بندی با موفقیت ایجاد شد");
      // Soft-navigate: a full reload tears down the Toaster before the success
      // toast paints, so creating a category looked identical to failing. The
      // list page calls useFreshDataOnPageLoad(), which fires setRefresh(true)
      // on mount, so the hard reload this replaces was not buying fresh data.
      router.push("/products/categories");
    } catch (error: unknown) {
      console.error("Failed to create category:", error);
      const rawErrorMessage = extractErrorMessage(error);
      const message = translateErrorMessage(
        rawErrorMessage,
        "ایجاد دسته‌بندی با خطا مواجه شد",
      );
      toast.error(message);
    }
  };

  return (
    <UpsertPageContentWrapper<ProductCategoryForm>
      config={getCategoryFormConfig({ mode: "create" })}
      data={createEmptyCategoryFormData()}
      onSubmit={handleSubmit}
      customSidebar={
        <div className="flex flex-col gap-4">
          <CategoryAppearancePanel
            image={categoryImage}
            onImageChange={setCategoryImage}
          />
          <CategoryAppearancePanel
            image={megaMenuImage}
            onImageChange={setMegaMenuImage}
            title="تصویر مگامنو دسکتاپ"
            previewAlt="تصویر مگامنو دسته‌بندی"
            uploadLabel="بارگذاری تصویر مگامنو"
            successMessage="تصویر مگامنو با موفقیت بارگذاری شد"
            errorMessage="خطا در آپلود تصویر مگامنو"
            aspectClassName="aspect-[363/430]"
          />
        </div>
      }
    />
  );
}
