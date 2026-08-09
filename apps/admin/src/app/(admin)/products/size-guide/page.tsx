"use client";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { MobileTable, columns } from "./table";
import { ENDPOINTS } from "@/constants/api";
import { useState } from "react";
import { useFreshDataOnPageLoad } from "@/hooks/useFreshDataOnPageLoad";
import { useCan } from "@/hooks/useCan";

export default function SizeGuidePage() {
  useFreshDataOnPageLoad();
  const canDeleteSizeGuides = useCan("product.size-guide.delete");
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);

  return (
    <ContentWrapper
      title="راهنمای اندازه"
      hasFilterButton
      hasPagination
      hasRecycleBin={canDeleteSizeGuides}
      apiUrl={ENDPOINTS.PRODUCT.SIZE_HELPER}
      isRecycleBinOpen={isRecycleBinOpen}
      setIsRecycleBinOpen={setIsRecycleBinOpen}
      filterOptions={[
        { id: "[Title]", title: "نام", type: "text" },
        { id: "[createdAt]", title: "تاریخ ایجاد", type: "date" },
      ]}
    >
      <SuperAdminTable
        columns={columns}
        url={
          isRecycleBinOpen
            ? `${ENDPOINTS.PRODUCT.SIZE_HELPER}?filters[removedAt][$null]=false`
            : `${ENDPOINTS.PRODUCT.SIZE_HELPER}?filters[removedAt][$null]=true`
        }
        mobileTable={(data) => <MobileTable data={data} />}
      />
    </ContentWrapper>
  );
}
