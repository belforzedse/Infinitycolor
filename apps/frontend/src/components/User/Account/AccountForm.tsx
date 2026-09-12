"use client";
import type { FormEvent, ChangeEvent } from "react";
import { useState, useEffect, useMemo } from "react";
import Input from "@/components/Kits/Form/Input";
import SaveIcon from "../Icons/SaveIcon";
import useUser from "@/hooks/useUser";
import { updateProfile } from "@/services/user/updateProfile";
import { toast } from "react-hot-toast";
import { extractErrorMessage, translateErrorMessage } from "@/lib/errorTranslations";
import { faNum } from "@/utils/faNum";
import {
  BIRTH_DATE_PLACEHOLDERS,
  BIRTH_DATE_YEAR_MIN,
  currentJalaliYear,
  jalaliBirthDateToGregorianDate,
  jalaliMonthLength,
  normalizeBirthDatePart,
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
  const [birthDateError, setBirthDateError] = useState<string | null>(null);
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
      setBirthDateError(null);
    }
  }, [userData]);

  const maxYear = useMemo(() => currentJalaliYear(), []);

  // The day bound is the real length of the chosen month, not a flat 31: Mehr-Esfand
  // have 30 days (29 in a common-year Esfand), so a hardcoded 31 invited a date that
  // does not exist and then failed to convert.
  const maxDay = useMemo(() => {
    const length = jalaliMonthLength(formData.birthYear, formData.birthMonth);
    return length > 0 ? length : 31;
  }, [formData.birthYear, formData.birthMonth]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const { birthYear, birthMonth, birthDay } = formData;
    const filledParts = [birthYear, birthMonth, birthDay].filter(Boolean).length;

    let birthDatePayload: string | null;
    if (filledParts === 0) {
      // All three cleared means "remove my birth date"; the backend accepts null.
      birthDatePayload = null;
    } else if (filledParts < 3) {
      setBirthDateError("تاریخ تولد را کامل وارد کنید: سال، ماه و روز.");
      return;
    } else {
      const formatted = jalaliBirthDateToGregorianDate(birthYear, birthMonth, birthDay);
      if (!formatted) {
        // Previously this fell back to the stored value and still showed a success
        // toast, which is why the birth date looked impossible to change.
        const monthLength = jalaliMonthLength(birthYear, birthMonth);
        setBirthDateError(
          monthLength > 0 && Number(birthDay) > monthLength
            ? `این ماه ${faNum(String(monthLength))} روز دارد.`
            : "تاریخ تولد وارد شده معتبر نیست.",
        );
        return;
      }
      birthDatePayload = formatted;
    }

    setBirthDateError(null);

    try {
      setIsSaving(true);

      await updateProfile({
        FirstName: formData.firstName,
        LastName: formData.lastName,
        BirthDate: birthDatePayload,
        // Only sent when there is an answer to send. The form does not render a national
        // code field, so that one is never submitted either.
        ...(formData.gender ? { Sex: formData.gender } : {}),
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

  const handleBirthPartChange =
    (name: "birthYear" | "birthMonth" | "birthDay", maxLength: number) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      setBirthDateError(null);
      handleInputChange(name, normalizeBirthDatePart(event.target.value, maxLength));
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

        <fieldset>
          <legend className="text-foreground-primary mb-2 block text-sm font-medium">
            جنسیت
          </legend>
          <div className="flex flex-wrap gap-3">
            {GENDER_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2.5 text-sm transition-colors ${
                  formData.gender === option.value
                    ? "border-infinity-primary bg-infinity-primary/5 text-infinity-primary"
                    : "border-neutral-200 text-slate-600 hover:border-infinity-primary-lighter"
                }`}
              >
                <input
                  type="radio"
                  name="gender"
                  value={option.value}
                  checked={formData.gender === option.value}
                  onChange={() => handleInputChange("gender", option.value)}
                  className="accent-infinity-primary"
                />
                <span>{option.label}</span>
              </label>
            ))}
            {formData.gender && (
              <button
                type="button"
                onClick={() => handleInputChange("gender", "")}
                className="rounded-lg px-3 py-2.5 text-sm text-slate-500 underline-offset-4 hover:underline"
              >
                پاک کردن
              </button>
            )}
          </div>
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
            {/* `type="text"` with a numeric keypad rather than `type="number"`: browsers
                reject Persian digits in a number field, so the value silently read back
                empty for anyone typing ۱۳۷۰. */}
            <Input
              label=""
              name="birthYear"
              type="text"
              inputMode="numeric"
              value={formData.birthYear}
              onChange={handleBirthPartChange("birthYear", 4)}
              placeholder={BIRTH_DATE_PLACEHOLDERS.year}
              aria-label="سال تولد"
              dir="ltr"
            />
            <Input
              label=""
              name="birthMonth"
              type="text"
              inputMode="numeric"
              value={formData.birthMonth}
              onChange={handleBirthPartChange("birthMonth", 2)}
              placeholder={BIRTH_DATE_PLACEHOLDERS.month}
              aria-label="ماه تولد"
              dir="ltr"
            />
            <Input
              label=""
              name="birthDay"
              type="text"
              inputMode="numeric"
              value={formData.birthDay}
              onChange={handleBirthPartChange("birthDay", 2)}
              placeholder={BIRTH_DATE_PLACEHOLDERS.day}
              aria-label="روز تولد"
              dir="ltr"
            />
          </div>
          <p className="mt-1 text-right text-xs text-slate-500">
            {`سال بین ${faNum(String(BIRTH_DATE_YEAR_MIN))} تا ${faNum(String(maxYear))}، ماه ۱ تا ۱۲، روز ۱ تا ${faNum(String(maxDay))}`}
          </p>
          {birthDateError && (
            <p role="alert" className="mt-1 text-right text-sm text-red-500">
              {birthDateError}
            </p>
          )}
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
