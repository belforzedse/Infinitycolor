import React from "react";
import Illustration from "@/components/Contact/Illustration";
import ContactUs from "@/components/Contact/ContactUs";
import ContactHeader from "@/components/Contact/ContactHeader";
import { getSiteIdentity } from "@/services/site-identity";
import StoreAddressLine from "@/components/identity/StoreAddressLine";

// Homepage links may warm the shared product layout, but never this page body.
export const prefetch = "force-disabled";

const page = async () => {
  const identity = await getSiteIdentity();
  const physicalStores = identity.hasPhysicalStores
    ? identity.stores.filter((store) => store.name || store.address)
    : [];

  return (
    <div className="mb-[122px] mt-20 flex flex-row-reverse items-center justify-center px-5 py-6 max-md:flex max-md:flex-col-reverse max-md:items-center max-md:justify-center ">
      <Illustration />
      <div className="ml-[77px] flex flex-col rounded-[20px] bg-stone-50 p-4 max-md:mx-auto max-md:mb-5">
        <ContactHeader />
        <div className="flex flex-col">
          <div className="flex gap-3 max-md:flex max-md:flex-col">
            {physicalStores.length > 0 && (
              <div className="rounded-xl bg-white p-4">
                <p className="mb-3 font-[Peyda(FaNum)] text-xl/[27.8px] text-neutral-900">
                  مراجعه حضوری
                </p>
                <div className="flex flex-col gap-2">
                  {physicalStores.map((store, index) => (
                    <p
                      key={store.id ?? index}
                      className="font-[Peyda(FaNum)] text-sm/[26.6px] text-neutral-500"
                    >
                      <StoreAddressLine store={store} />
                    </p>
                  ))}
                </div>
              </div>
            )}
            {identity.supportHours && (
              <div className="rounded-xl bg-white p-4">
                <p className="mb-3 font-[Peyda(FaNum)] text-xl/[27.8px] text-neutral-900">
                  پشتیبانی مشتریان
                </p>
                <p className="font-[Peyda(FaNum)] text-sm/[26.6px] text-neutral-500">
                  {identity.supportHours}
                </p>
              </div>
            )}
          </div>
          <ContactUs
            contactNumbers={identity.contactNumbers}
            socialLinks={identity.socialLinks}
          />
        </div>
      </div>
    </div>
  );
};

export default page;
