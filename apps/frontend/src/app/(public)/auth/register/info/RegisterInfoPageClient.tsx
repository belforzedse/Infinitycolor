"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAtom } from "jotai";
import AuthTitle from "@/components/Kits/Auth/Title";
import Text from "@/components/Kits/Text";
import AuthInput from "@/components/Kits/Auth/Input";
import AuthButton from "@/components/Kits/Auth/Button";
import AuthPasswordInput from "@/components/Kits/Auth/Input/Password";
import { AuthService, UserService } from "@/services";
import toast from "react-hot-toast";
import AuthReturnButton from "@/components/Auth/ReturnButton";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import { currentUserAtom, userErrorAtom, userLoadingAtom } from "@/lib/atoms/auth";
import {
  BIRTH_DATE_PLACEHOLDERS,
  jalaliBirthDateToGregorianDate,
  jalaliMonthLength,
  normalizeBirthDatePart,
} from "@/utils/birthDate";
import { safeInternalRedirect } from "@/utils/authRedirect";
import { trackAnalyticsEvent } from "@/lib/analytics";

interface FormData {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  birthYear: string;
  birthMonth: string;
  birthDay: string;
  password: string;
  confirmPassword: string;
}

export default function RegisterInfoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [birthDateError, setBirthDateError] = useState<string | null>(null);
  const [, setUserData] = useAtom(currentUserAtom);
  const [, setUserLoading] = useAtom(userLoadingAtom);
  const [, setUserError] = useAtom(userErrorAtom);
  const [formData, setFormData] = useState<FormData>({
    firstName: "",
    lastName: "",
    phoneNumber: "",
    birthYear: "",
    birthMonth: "",
    birthDay: "",
    password: "",
    confirmPassword: "",
  });

  useEffect(() => {
    const paramsPhone = searchParams.get("phone");
    const phoneToUse = paramsPhone;

    if (phoneToUse) {
      setFormData((prev) => ({ ...prev, phoneNumber: phoneToUse }));
    } else {
      toast.error("لطفاً ابتدا شماره خود را تأیید کنید.");
      router.replace("/auth");
    }
  }, [router, searchParams]);

  const normalizePhone = (value: string) => {
    if (!value) return value;
    let trimmed = value.trim();
    if (trimmed.startsWith("+")) return trimmed;
    if (trimmed.startsWith("0")) trimmed = trimmed.substring(1);
    if (!trimmed.startsWith("98")) trimmed = `98${trimmed}`;
    return `+${trimmed}`;
  };

  const formatBirthDate = (year: string, month: string, day: string): string => {
    return jalaliBirthDateToGregorianDate(year, month, day) || "";
  };

  /**
   * The birth date is optional here, but a partial or impossible one must not be dropped
   * silently: it used to be coerced to "" and posted as if the shopper had left it blank.
   */
  const validateBirthDate = (): boolean => {
    const { birthYear, birthMonth, birthDay } = formData;
    const filledParts = [birthYear, birthMonth, birthDay].filter(Boolean).length;
    if (filledParts === 0) {
      setBirthDateError(null);
      return true;
    }
    if (filledParts < 3) {
      setBirthDateError("تاریخ تولد را کامل وارد کنید: سال، ماه و روز.");
      return false;
    }
    if (!jalaliBirthDateToGregorianDate(birthYear, birthMonth, birthDay)) {
      const monthLength = jalaliMonthLength(birthYear, birthMonth);
      setBirthDateError(
        monthLength > 0 && Number(birthDay) > monthLength
          ? `این ماه ${monthLength} روز دارد.`
          : "تاریخ تولد وارد شده معتبر نیست.",
      );
      return false;
    }
    setBirthDateError(null);
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateBirthDate()) return;
    setIsLoading(true);
    try {
      const normalizedPhone = normalizePhone(formData.phoneNumber);
      const birthDate = formatBirthDate(formData.birthYear, formData.birthMonth, formData.birthDay);
      const res = await AuthService.register({
        firstName: formData.firstName,
        lastName: formData.lastName,
        password: formData.password,
        phone: normalizedPhone,
        birthDate: birthDate,
      });

      if (res.token || res.message) {
        trackAnalyticsEvent({ category: "auth", action: "account_created" });
        try {
          setUserLoading(true);
          setUserError(null);
          const me = await UserService.me();
          setUserData(me);
        } catch {
          setUserData(null);
          setUserError(new Error("به‌روزرسانی اطلاعات کاربر ناموفق بود. دوباره تلاش کنید"));
        } finally {
          setUserLoading(false);
        }

        // If user came from login redirect (incomplete profile), send to their intended destination or account
        const redirectTarget = safeInternalRedirect(searchParams.get("redirect"));
        if (redirectTarget) {
          router.push(redirectTarget);
        } else {
          router.push("/account");
        }
      }
    } catch (error: unknown) {
      console.error(error);
      toast.error(getUserFacingErrorMessage(error, "خطا در ثبت اطلاعات. لطفاً دوباره تلاش کنید"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (field: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({
      ...prev,
      [field]: e.target.value,
    }));
  };

  const handleBirthPartChange =
    (field: "birthYear" | "birthMonth" | "birthDay", maxLength: number) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setBirthDateError(null);
      setFormData((prev) => ({
        ...prev,
        [field]: normalizeBirthDatePart(e.target.value, maxLength),
      }));
    };

  return (
    <div className="space-y-8" dir="rtl">
      <AuthTitle subtitle="لطفاً اطلاعات خود را تکمیل نمایید">ایجاد حساب کاربری</AuthTitle>
      <div>
        <AuthReturnButton href="/" label="بازگشت به فروشگاه" preserveRedirect />
      </div>

      <form onSubmit={handleSubmit} className="space-y-7">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 md:gap-6">
          <div>
            <Text variant="label" className="mb-2 md:mb-2.5">
              نام
            </Text>
            <AuthInput
              type="text"
              value={formData.firstName}
              onChange={handleChange("firstName")}
              placeholder="نام"
            />
          </div>
          <div>
            <Text variant="label" className="mb-2 md:mb-2.5">
              نام خانوادگی
            </Text>
            <AuthInput
              type="text"
              value={formData.lastName}
              onChange={handleChange("lastName")}
              placeholder="نام خانوادگی"
            />
          </div>
        </div>

        <div>
          <Text variant="label" className="mb-2 md:mb-2.5">
            تاریخ تولد
          </Text>
          {/* `type="text"` with a numeric keypad rather than `type="number"`: browsers
              reject Persian digits in a number field, so the value silently read back
              empty for anyone typing ۱۳۷۰. */}
          <div className="flex gap-2">
            <div className="flex-1">
              <AuthInput
                type="text"
                inputMode="numeric"
                value={formData.birthYear}
                onChange={handleBirthPartChange("birthYear", 4)}
                placeholder={BIRTH_DATE_PLACEHOLDERS.year}
                aria-label="سال تولد"
              />
            </div>
            <div className="flex-1">
              <AuthInput
                type="text"
                inputMode="numeric"
                value={formData.birthMonth}
                onChange={handleBirthPartChange("birthMonth", 2)}
                placeholder={BIRTH_DATE_PLACEHOLDERS.month}
                aria-label="ماه تولد"
              />
            </div>
            <div className="flex-1">
              <AuthInput
                type="text"
                inputMode="numeric"
                value={formData.birthDay}
                onChange={handleBirthPartChange("birthDay", 2)}
                placeholder={BIRTH_DATE_PLACEHOLDERS.day}
                aria-label="روز تولد"
              />
            </div>
          </div>
          {birthDateError && (
            <p role="alert" className="mt-1 text-right text-sm text-red-500">
              {birthDateError}
            </p>
          )}
        </div>

        <div>
          <Text variant="label" className="mb-2 md:mb-2.5">
            شماره همراه
          </Text>
          <AuthInput
            type="tel"
            value={formData.phoneNumber}
            onChange={handleChange("phoneNumber")}
            placeholder="09122032114"
            disabled
          />
        </div>

        <div className="space-y-3">
          <div>
            <Text variant="label" className="mb-2 md:mb-2.5">
              رمز عبور
            </Text>
            <AuthPasswordInput
              value={formData.password}
              onChange={handleChange("password")}
              showStrength
            />
          </div>

          <div>
            <Text variant="label" className="mb-2 md:mb-2.5">
              تکرار رمز عبور
            </Text>
            <AuthPasswordInput
              value={formData.confirmPassword}
              onChange={handleChange("confirmPassword")}
              error={
                formData.confirmPassword && formData.password !== formData.confirmPassword
                  ? "رمز عبور مطابقت ندارد"
                  : undefined
              }
            />
          </div>
        </div>

        <AuthButton
          type="submit"
          aria-busy={isLoading}
          disabled={
            isLoading ||
            !formData.firstName ||
            !formData.lastName ||
            !formData.birthYear ||
            !formData.birthMonth ||
            !formData.birthDay ||
            !formData.password ||
            !formData.confirmPassword ||
            formData.password !== formData.confirmPassword
          }
        >
          {isLoading ? "در حال ثبت نام..." : "ایجاد حساب کاربری"}
        </AuthButton>
      </form>
    </div>
  );
}
