"use client";

import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { MobileTable, columns } from "./table";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import ShippingTabs from "@/components/SuperAdmin/ShippingTabs";
import { useState } from "react";
import { useFreshDataOnPageLoad } from "@/hooks/useFreshDataOnPageLoad";

export default function ShippingPage() {
  useFreshDataOnPageLoad();
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <ShippingTabs selectedTab="shipping" />

      <ContentWrapper
        title="روش های حمل و نقل"
        hasRecycleBin
        isRecycleBinOpen={isRecycleBinOpen}
        setIsRecycleBinOpen={setIsRecycleBinOpen}
        apiUrl="/shippings"
        hasFilterButton
        filterOptions={[
          {
            id: "[Title]",
            title: "عنوان",
            type: "text",
          },
          {
            id: "[Price]",
            title: "هزینه",
            type: "number",
          },
          {
            id: "[IsActive]",
            title: "فعال",
            type: "boolean",
          },
          {
            id: "[createdAt]",
            title: "تاریخ ایجاد",
            type: "date",
          },
        ]}
      >
        <SuperAdminTable
          columns={columns}
          _removeActions
          url={
            isRecycleBinOpen
              ? "/shippings?filters[removedAt][$null]=false"
              : "/shippings?filters[removedAt][$null]=true"
          }
          mobileTable={(data) => <MobileTable data={data} />}
        />
      </ContentWrapper>
    </div>
  );
}
