"use client";

import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { columns, MobileTable } from "./table";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { useFreshDataOnPageLoad } from "@/hooks/useFreshDataOnPageLoad";

export default function CartsPage() {
  useFreshDataOnPageLoad();
  return (
    <ContentWrapper
      title="سبد خرید"
      hasFilterButton
      hasPagination
      filterOptions={[
        { id: "[user][user_info][FirstName]", title: "نام فرد", type: "text" },
        { id: "[user][user_info][LastName]", title: "نام خانوادگی فرد", type: "text" },
        { id: "[user][phone]", title: "شماره تماس فرد", type: "text" },
        {
          id: "[Status]",
          title: "وضعیت سبد",
          type: "select",
          options: [
            { id: "Pending", title: "در انتظار" },
            { id: "Payment", title: "پرداخت" },
            { id: "Left", title: "رها شده" },
            { id: "Empty", title: "خالی" },
          ],
        },
        { id: "[createdAt]", title: "تاریخ ایجاد", type: "date" },
      ]}
    >
      <SuperAdminTable
        columns={columns}
        _removeActions
        url="/carts?populate[0]=user&populate[1]=cart_items&populate[2]=cart_items.product_variation&populate[3]=cart_items.product_variation.product&populate[4]=cart_items.product_variation.product.CoverImage&populate[5]=user.user_info"
        mobileTable={(data) => <MobileTable data={data} />}
      />
    </ContentWrapper>
  );
}
