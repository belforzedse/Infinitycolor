"use client";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { SuperAdminTable, refreshTable } from "@/components/SuperAdmin/Table";
import { MobileTable, getCategoryColumns } from "./table";
import DeleteCategoryModal from "@/components/SuperAdmin/DeleteCategoryModal";
import { ENDPOINTS } from "@/constants/api";
import { useFreshDataOnPageLoad } from "@/hooks/useFreshDataOnPageLoad";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSetAtom } from "jotai";
import toast from "react-hot-toast";
import { extractErrorMessage, translateErrorMessage } from "@/lib/errorTranslations";
import { deleteCategory } from "@/services/super-admin/product/category/delete";
import type { DeleteCategoryModalCategory } from "@/components/SuperAdmin/DeleteCategoryModal";

export default function CategoriesPage() {
  useFreshDataOnPageLoad();
  const router = useRouter();
  const { roleName } = useCurrentUser();
  const canDeleteCategories = (roleName ?? "").toLowerCase().trim() === "superadmin";
  const setRefresh = useSetAtom(refreshTable);
  const [deleteModalCategory, setDeleteModalCategory] =
    useState<DeleteCategoryModalCategory | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Redirect editors away from product pages
  useEffect(() => {
    const normalizedRole = (roleName ?? "").toLowerCase().trim();
    if (normalizedRole === "editor") {
      router.replace("/super-admin/blog");
    }
  }, [roleName, router]);

  const handleDelete = useCallback((category: DeleteCategoryModalCategory) => {
    setDeleteModalCategory(category);
  }, []);

  const handleConfirmDelete = useCallback(
    async (targetCategoryId: number) => {
      if (!deleteModalCategory) return;
      const id =
        typeof deleteModalCategory.id === "string"
          ? deleteModalCategory.id
          : String(deleteModalCategory.id);
      setIsDeleting(true);
      try {
        await deleteCategory(id, targetCategoryId);
        toast.success("دسته‌بندی با موفقیت حذف شد");
        setDeleteModalCategory(null);
        setRefresh(true);
      } catch (err) {
        const rawMessage = extractErrorMessage(err);
        toast.error(translateErrorMessage(rawMessage, "خطا در حذف دسته‌بندی"));
      } finally {
        setIsDeleting(false);
      }
    },
    [deleteModalCategory, setRefresh],
  );

  const columns = useMemo(
    () => getCategoryColumns(canDeleteCategories ? handleDelete : undefined),
    [canDeleteCategories, handleDelete],
  );
  return (
    <>
      <ContentWrapper
        title="دسته‌بندی‌ها"
        hasFilterButton
        hasPagination
        hasAddButton
        addButtonText="افزودن دسته‌بندی"
        addButtonPath="/super-admin/products/categories/add"
        filterOptions={[
          { id: "[Title]", title: "نام", type: "text" },
          { id: "[Slug]", title: "نامک", type: "text" },
          { id: "[createdAt]", title: "تاریخ ایجاد", type: "date" },
        ]}
      >
        <SuperAdminTable
          _removeActions
          columns={columns}
          className="w-full [&_tbody]:grid [&_tbody]:grid-cols-1 [&_tbody]:gap-5 sm:[&_tbody]:grid-cols-2 lg:[&_tbody]:grid-cols-3 [&_tbody_tr]:border-0 [&_tbody_tr]:bg-transparent [&_tbody_tr]:shadow-none [&_tbody_tr]:hover:bg-transparent [&_tbody_tr_td]:p-0 [&_thead]:hidden"
          url={`${ENDPOINTS.PRODUCT.CATEGORY}?populate[children]=*&populate[Image]=*&filters[parent][id][$null]=true`}
          mobileTable={(data) => (
            <MobileTable data={data} onDelete={canDeleteCategories ? handleDelete : undefined} />
          )}
        />
      </ContentWrapper>
      {canDeleteCategories && (
        <DeleteCategoryModal
          isOpen={deleteModalCategory !== null}
          onClose={() => setDeleteModalCategory(null)}
          category={deleteModalCategory}
          onConfirm={handleConfirmDelete}
          isDeleting={isDeleting}
        />
      )}
    </>
  );
}
