"use client";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { MobileTable, columns } from "./table";
import { ENDPOINTS } from "@/constants/api";
import { useFreshDataOnPageLoad } from "@/hooks/useFreshDataOnPageLoad";

// product-size-helper only declares `product` and `Helper`, so it has no
// soft-delete column and nothing to filter or display by name of its own.
const SIZE_HELPER_LIST_URL = `${ENDPOINTS.PRODUCT.SIZE_HELPER}?populate[product][fields][0]=Title`;

export default function SizeGuidePage() {
  useFreshDataOnPageLoad();

  return (
    <ContentWrapper
      title="راهنمای اندازه"
      hasFilterButton
      hasPagination
      apiUrl={ENDPOINTS.PRODUCT.SIZE_HELPER}
      filterOptions={[
        { id: "[product][Title]", title: "محصول", type: "text" },
        { id: "[createdAt]", title: "تاریخ ایجاد", type: "date" },
      ]}
    >
      <SuperAdminTable
        columns={columns}
        url={SIZE_HELPER_LIST_URL}
        mobileTable={(data) => <MobileTable data={data} />}
      />
    </ContentWrapper>
  );
}
