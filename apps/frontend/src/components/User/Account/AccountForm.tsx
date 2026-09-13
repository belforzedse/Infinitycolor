"use client";
import type { FormEvent, ChangeEvent } from "react";
import { useState, useEffect } from "react";
import Input from "@/components/Kits/Form/Input";
import SaveIcon from "../Icons/SaveIcon";
import useUser from "@/hooks/useUser";
import { updateProfile } from "@/services/user/updateProfile";
import { toast } from "react-hot-toast";
import { extractErrorMessage, translateErrorMessage } from "@/lib/errorTranslations";
import {
  BIRTH_DATE_PLACEHOLDERS,
  parseStoredBirthDateToJalaliParts,
  unpadBirthDatePart,
} from "@/utils/birthDate";

type Gender = "male" | "female" | "";

interface AccountFormData {
  firstName: string;
  lastName: string;
  phone: string;
  birthYear: string;
  birthMonth: string;
  birthDay: string;
  gender: Gender;
}

const GENDER_OPTIONS: { value: Exclude<Gender, "">; label: string }[] = [
  { value: "female", label: "زن" },
  { value: "male", label: "مرد" },
];

const EMPTY_FORM: AccountFormData = {
  firstName: "",
  lastName: "",
  phone: "",
  birthYear: "",
  birthMonth: "",
  birthDay: "",
  gender: "",
};

export default function AccountForm() {
  const { userData, isLoading, error, refetch } = useUser();
  const [formData, setFormData] = useState<AccountFormData>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);

  // Mark component as hydrated to prevent hydration mismatches with loading state
  useEffect(() => {
    setIsHydrated(true);
  }, []);

  // Update form when user data is loaded
  useEffect(() => {
    if (userData) {
      const { birthYear, birthMonth, birthDay } = parseStoredBirthDateToJalaliParts(
        userData.BirthDate,
      );
      setFormData({
        firstName: userData.FirstName || "",
        lastName: userData.LastName || "",
        phone: userData.Phone || "",
        // The stored parts are zero-padded for storage; `01`/`08` in an input reads as a
        // defect, so show them the way a person writes them.
        birthYear: unpadBirthDatePart(birthYear),
        birthMonth: unpadBirthDatePart(birthMonth),
        birthDay: unpadBirthDatePart(birthDay),
        gender: userData.Sex ?? "",
      });
    }
  }, [userData]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    try {
      setIsSaving(true);

      await updateProfile({
        FirstName: formData.firstName,
        LastName: formData.lastName,
      });

      // Refresh user data
      await refetch();

      toast.success("اطلاعات حساب کاربری با موفقیت بروزرسانی شد");
    } catch (error: any) {
      console.error("Error updating profile:", error);
      const rawErrorMessage = extractErrorMessage(error);
      const message = translateErrorMessage(rawErrorMessage, "خطا در بروزرسانی اطلاعات");
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleInputChange = (name: keyof AccountFormData, value: string) => {
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  // Only show loading/error states after hydration to prevent mismatches
  if (isHydrated && isLoading) {
    return (
      <div className="flex flex-col gap-4 rounded-lg bg-white p-6 shadow-sm">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-infinity-primary"></div>
        </div>
      </div>
    );
  }

  if (isHydrated && error) {
    return (
      <div className="flex flex-col gap-4 rounded-lg bg-white p-6 shadow-sm">
        <span className="text-lg font-medium text-red-600">خطا در بارگذاری اطلاعات کاربر</span>
        <button
          onClick={refetch}
          className="w-fit rounded-lg bg-[#3d4c6e] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-infinity-primary"
        >
          تلاش مجدد
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 rounded-lg bg-white p-6 shadow-sm">
      <h2 className="text-foreground-primary text-lg font-semibold">اطلاعات حساب کاربری</h2>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Input
            label="نام"
            name="firstName"
            value={formData.firstName}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              handleInputChange("firstName", e.target.value)
            }
            placeholder="نام"
          />

          <Input
            label="نام خانوادگی"
            name="lastName"
            value={formData.lastName}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              handleInputChange("lastName", e.target.value)
            }
            placeholder="نام خانوادگی"
          />
        </div>

        <fieldset disabled aria-describedby="gender-read-only-note">
          <legend className="text-foreground-primary mb-2 block text-sm font-medium">جنسیت</legend>
          <div className="flex flex-wrap gap-3">
            {GENDER_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-not-allowed items-center gap-2 rounded-lg border bg-neutral-100 px-4 py-2.5 text-sm text-slate-400 ${
                  formData.gender === option.value ? "border-slate-300" : "border-neutral-200"
                }`}
              >
                <input
                  type="radio"
                  name="gender"
                  value={option.value}
                  checked={formData.gender === option.value}
                  disabled
                  className="cursor-not-allowed accent-slate-400"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <p id="gender-read-only-note" className="mt-1 text-right text-xs text-slate-500">
            از این صفحه قابل تغییر نیست.
          </p>
        </fieldset>

        <div>
          <Input
            label="شماره همراه"
            name="phone"
            type="tel"
            value={formData.phone}
            placeholder="09122034113"
            dir="ltr"
            disabled={true}
          />
        </div>

        <div>
          <label className="text-foreground-primary mb-2 block text-sm font-medium">
            تاریخ تولد
          </label>
          <div className="flex gap-2">
            <Input
              label=""
              name="birthYear"
              type="text"
              inputMode="numeric"
              value={formData.birthYear}
              placeholder={BIRTH_DATE_PLACEHOLDERS.year}
              aria-label="سال تولد"
              aria-describedby="birth-date-read-only-note"
              dir="ltr"
              disabled
              className="cursor-not-allowed border-neutral-200 bg-neutral-100 text-slate-400 opacity-100"
            />
            <Input
              label=""
              name="birthMonth"
              type="text"
              inputMode="numeric"
              value={formData.birthMonth}
              placeholder={BIRTH_DATE_PLACEHOLDERS.month}
              aria-label="ماه تولد"
              aria-describedby="birth-date-read-only-note"
              dir="ltr"
              disabled
              className="cursor-not-allowed border-neutral-200 bg-neutral-100 text-slate-400 opacity-100"
            />
            <Input
              label=""
              name="birthDay"
              type="text"
              inputMode="numeric"
              value={formData.birthDay}
              placeholder={BIRTH_DATE_PLACEHOLDERS.day}
              aria-label="روز تولد"
              aria-describedby="birth-date-read-only-note"
              dir="ltr"
              disabled
              className="cursor-not-allowed border-neutral-200 bg-neutral-100 text-slate-400 opacity-100"
            />
          </div>
          <p id="birth-date-read-only-note" className="mt-1 text-right text-xs text-slate-500">
            از این صفحه قابل تغییر نیست.
          </p>
        </div>

        <div className="flex w-full justify-end border-t border-neutral-200 pt-6">
          <button
            type="submit"
            className="flex items-center justify-center gap-2 rounded-lg bg-[#3d4c6e] px-8 py-3 text-sm font-medium text-white transition-all hover:bg-infinity-primary disabled:cursor-not-allowed disabled:bg-infinity-primary-lighter disabled:hover:bg-infinity-primary-lighter"
            disabled={isSaving}
          >
            {isSaving ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                <span>در حال ذخیره...</span>
              </>
            ) : (
              <>
                <SaveIcon className="h-5 w-5" />
                <span>ذخیره تغییرات</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
