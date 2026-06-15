"use client";

import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { MobileTable, createColumns } from "./table";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { useMemo, useState } from "react";
import { useFreshDataOnPageLoad } from "@/hooks/useFreshDataOnPageLoad";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export default function CouponsPage() {
  useFreshDataOnPageLoad();
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);
  const { isStoreManager } = useCurrentUser();
  const canManageDiscounts = !isStoreManager;
  const columns = useMemo(() => createColumns(canManageDiscounts), [canManageDiscounts]);

  return (
    <ContentWrapper
      title="کد تخفیف"
      hasAddButton={canManageDiscounts}
      addButtonPath={canManageDiscounts ? "/super-admin/coupons/add" : undefined}
      addButtonText={canManageDiscounts ? "کد تخفیف جدید" : undefined}
      hasFilterButton
      filterOptions={[
        { id: "[Code]", title: "کد تخفیف", type: "text" },
        {
          id: "[Type]",
          title: "نوع تخفیف",
          type: "select",
          options: [
            { id: "Cash", title: "ثابت" },
            { id: "Discount", title: "درصدی" },
          ],
        },
        { id: "[Amount]", title: "میزان تخفیف", type: "number" },
        { id: "[LimitUsage]", title: "محدودیت مصرف", type: "number" },
        { id: "[UsedTimes]", title: "تعداد مصرف شده", type: "number" },
        { id: "[MinCartTotal]", title: "حداقل سبد خرید", type: "number" },
        { id: "[MaxCartTotal]", title: "حداکثر سبد خرید", type: "number" },
        { id: "[StartDate]", title: "تاریخ شروع", type: "date" },
        { id: "[EndDate]", title: "تاریخ انقضا", type: "date" },
        { id: "[IsActive]", title: "فعال", type: "boolean" },
      ]}
      hasRecycleBin
      isRecycleBinOpen={isRecycleBinOpen}
      setIsRecycleBinOpen={setIsRecycleBinOpen}
      apiUrl={"/discounts"}
      hasPagination
    >
      <SuperAdminTable
        _removeActions
        columns={columns}
        url={
          isRecycleBinOpen
            ? "/discounts?populate[products]=*&populate[delivery_methods]=*&filters[removedAt][$null]=false"
            : "/discounts?populate[products]=*&populate[delivery_methods]=*&filters[removedAt][$null]=true"
        }
        mobileTable={(data) => (
          <MobileTable data={data} canManageDiscounts={canManageDiscounts} columns={columns} />
        )}
      />
    </ContentWrapper>
  );
}
