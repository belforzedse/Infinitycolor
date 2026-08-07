"use client";

import { SuperAdminTable } from "@/components/SuperAdmin/Table";
import { columns, MobileTable } from "./table";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { useFreshDataOnPageLoad } from "@/hooks/useFreshDataOnPageLoad";

/**
 * The list still needs the full relation depth — it renders product cover
 * thumbnails per cart item — but it previously requested every field at every
 * level. Narrowed to the fields the columns actually read; the depth is
 * unchanged so nothing stops rendering.
 */
const CARTS_LIST_URL = [
  "/carts?fields[0]=Status",
  "fields[1]=createdAt",
  "populate[user][fields][0]=Phone",
  "populate[user][populate][user_info][fields][0]=FirstName",
  "populate[user][populate][user_info][fields][1]=LastName",
  "populate[cart_items][fields][0]=Sum",
  "populate[cart_items][populate][product_variation][fields][0]=id",
  "populate[cart_items][populate][product_variation][populate][product][fields][0]=Title",
  "populate[cart_items][populate][product_variation][populate][product][populate][CoverImage][fields][0]=name",
  "populate[cart_items][populate][product_variation][populate][product][populate][CoverImage][fields][1]=url",
  "populate[cart_items][populate][product_variation][populate][product][populate][CoverImage][fields][2]=formats",
].join("&");

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
        url={CARTS_LIST_URL}
        mobileTable={(data) => <MobileTable data={data} />}
      />
    </ContentWrapper>
  );
}
