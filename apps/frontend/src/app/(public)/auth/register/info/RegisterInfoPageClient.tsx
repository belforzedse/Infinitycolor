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
import { safeInternalRedirect } from "@/utils/authRedirect";

interface FormData {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  password: string;
  confirmPassword: string;
}

export default function RegisterInfoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [, setUserData] = useAtom(currentUserAtom);
  const [, setUserLoading] = useAtom(userLoadingAtom);
  const [, setUserError] = useAtom(userErrorAtom);
  const [formData, setFormData] = useState<FormData>({
    firstName: "",
    lastName: "",
    phoneNumber: "",
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const normalizedPhone = normalizePhone(formData.phoneNumber);
      // Field removed from the form; backend treats it as optional, but we still
      // send a value since the storage column exists. Not a user-provided date.
      const birthDate = new Date().toISOString().slice(0, 10);
      const res = await AuthService.register({
        firstName: formData.firstName,
        lastName: formData.lastName,
        password: formData.password,
        phone: normalizedPhone,
        birthDate: birthDate,
      });

      if (res.token || res.message) {
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
