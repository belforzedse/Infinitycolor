import React from "react";
import CustomRadioGroup from "./CustomRadioGroup";
import type { ShippingOption } from "@/services/shipping";
import type { Control } from "react-hook-form";
import { Controller } from "react-hook-form";
import type { FormData } from "./index";

interface Props {
  shippingMethods: ShippingOption[];
  control: Control<FormData>;
  disabled?: boolean;
}

const ShoppingCartBillDeliveryOptions: React.FC<Props> = ({
  shippingMethods,
  control,
  disabled,
}) => {
  if (shippingMethods.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        در حال حاضر هیچ روش ارسالی برای این آدرس موجود نیست
      </div>
    );
  }

  const sortedShippingMethods = [...shippingMethods].sort(
    (a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0),
  );

  const deliveryOptions = sortedShippingMethods.map((method) => ({
    id: method.id.toString(),
    value: method.id.toString(),
    method,
    content: (
      <div className="flex w-full items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col text-right">
          <span className="text-sm text-neutral-800 lg:text-base">{method.title}</span>
          {(method.description || method.estimatedDeliveryText) && (
            <span className="mt-1 text-xs text-neutral-500">
              {method.description || method.estimatedDeliveryText}
            </span>
          )}
        </span>
        <span className="text-sm text-nowrap text-black lg:text-base">
          {method.price === 0 ? "رایگان" : `${method.price.toLocaleString()} تومان`}
        </span>
      </div>
    ),
  }));

  return (
    <div dir="rtl">
      {disabled && (
        <div className="text-sm mb-3 rounded-lg bg-amber-50 p-2 text-center text-amber-600">
          ابتدا آدرس تحویل را انتخاب کنید
        </div>
      )}
      <Controller
        control={control}
        name="shippingMethod"
        render={({ field }) => (
          <CustomRadioGroup
            options={deliveryOptions}
            value={field.value?.id.toString() || ""}
            name="delivery-method"
            disabled={disabled}
            onChange={(selectedValue) => {
              const selected = sortedShippingMethods.find(
                (method) => method.id.toString() === selectedValue,
              );
              if (selected) {
                field.onChange(selected);
              }
            }}
          />
        )}
      />
    </div>
  );
};

export default ShoppingCartBillDeliveryOptions;
