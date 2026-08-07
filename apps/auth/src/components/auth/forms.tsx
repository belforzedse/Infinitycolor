"use client";

import { useEffect, useRef, useState } from "react";
import {
  AuthButton,
  AuthInput,
  AuthPasswordInput,
  AuthReturnButton,
  AuthTitle,
  Checkbox,
  CodeIcon,
  LoginIcon,
  OtpIcon,
  PhoneInput,
  Text,
  VerificationInput,
} from "@repo/auth-ui";
import { jalaliBirthDateToGregorianDate } from "@repo/auth-core/birth-date";
import { authGet, authPost } from "./auth-api";
import { useAuthFlow } from "./auth-flow-context";
import { useOtpCountdown } from "./countdown";

const PHONE_PATTERN = /^(?:09[0-9]{9}|\+989[0-9]{9})$/;

interface RedirectResponse {
  message: string;
  redirectTo: string;
}

function ErrorAlert({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  if (!message) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      {message}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white"
    />
  );
}

function FieldLabel({
  htmlFor,
  children,
  className = "",
}: {
  htmlFor: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={`inline-block ${className}`}>
      <Text variant="label">{children}</Text>
    </label>
  );
}

function routeToRedirect(redirectTo: string) {
  if (redirectTo.startsWith("/")) {
    window.location.assign(redirectTo);
    return;
  }
  window.location.assign(redirectTo);
}

export function PhoneStatusForm({
  storefrontOrigin,
}: {
  storefrontOrigin: string;
}) {
  const { flowReady, setPhone, go } = useAuthFlow();
  const [phoneValue, setPhoneValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (!flowReady) return;
    if (!PHONE_PATTERN.test(phoneValue)) {
      setError("شماره همراه وارد شده معتبر نیست");
      return;
    }
    setLoading(true);
    try {
      await authPost<{ message: string }>(
        "/infinity/phone-status",
        { phone: phoneValue },
      );
      setPhone(phoneValue);
      await authPost("/infinity/otp/request", { phone: phoneValue });
      go("/auth/login/otp");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "بررسی شماره همراه ناموفق بود",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <AuthTitle subtitle="لطفا شماره همراه خود را جهت بررسی وارد نمایید">
        ورود به حساب کاربری
      </AuthTitle>
      <div className="mb-6">
        <AuthReturnButton href={storefrontOrigin} label="بازگشت به فروشگاه" />
      </div>
      <form
        onSubmit={submit}
        className="mt-8 space-y-6 md:space-y-7"
        autoComplete="on"
        noValidate
      >
        <div>
          <FieldLabel htmlFor="phone" className="mb-2 md:mb-2.5">
            شماره همراه
          </FieldLabel>
          <AuthInput
            id="phone"
            name="phone"
            type="tel"
            dir="ltr"
            inputMode="tel"
            autoComplete="tel"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="next"
            value={phoneValue}
            onChange={(event) => setPhoneValue(event.target.value)}
            placeholder="09122032114"
            error={error}
            aria-describedby={error ? "phone-error" : undefined}
            required
            aria-required="true"
          />
        </div>
        <AuthButton
          type="submit"
          disabled={loading || !flowReady}
          icon={loading ? <Spinner /> : undefined}
        >
          {loading ? "در حال بررسی..." : "بررسی شماره همراه"}
        </AuthButton>
      </form>
    </>
  );
}

export function PasswordLoginForm({
  storefrontOrigin,
}: {
  storefrontOrigin: string;
}) {
  const { phone, flowReady, setPhone, go } = useAuthFlow();
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (flowReady && !phone) go("/auth");
  }, [phone, flowReady, go]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!phone || !password) return;
    setError("");
    setLoading(true);
    try {
      const response = await authPost<RedirectResponse>(
        "/infinity/password/sign-in",
        {
          phone,
          password,
        },
      );
      routeToRedirect(response.redirectTo);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "رمز عبور یا شماره همراه اشتباه است",
      );
    } finally {
      setLoading(false);
    }
  };

  const beginOtp = async () => {
    if (!phone || loading) return;
    setLoading(true);
    setError("");
    try {
      await authPost("/infinity/otp/request", { phone });
      go("/auth/login/otp");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "خطا در ارسال کد تایید",
      );
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full">
      <AuthTitle subtitle="لطفا شماره همراه و رمز عبور خود را وارد نمایید">
        ورود به حساب کاربری
      </AuthTitle>
      <div className="mb-6">
        <AuthReturnButton href={storefrontOrigin} label="بازگشت به فروشگاه" />
      </div>
      <form onSubmit={submit} className="mt-8 space-y-7" autoComplete="on">
        <div className="space-y-7">
          <div>
            <FieldLabel htmlFor="login-phone" className="mb-2">
              شماره همراه
            </FieldLabel>
            <PhoneInput
              id="login-phone"
              name="username"
              autoComplete="username"
              value={phone}
              onEdit={() => {
                setPhone("");
                go("/auth");
              }}
            />
          </div>
          <div>
            <FieldLabel htmlFor="login-password" className="mb-2">
              رمز عبور
            </FieldLabel>
            <AuthPasswordInput
              id="login-password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <Checkbox
            checked={rememberMe}
            onChange={setRememberMe}
            label={<Text variant="helper">مرا به خاطر بسپار</Text>}
          />
        </div>
        <ErrorAlert message={error} />
        <AuthButton
          type="submit"
          disabled={loading || !phone || !password}
          icon={loading ? <Spinner /> : <LoginIcon className="h-6 w-6" />}
        >
          ورود به حساب کاربری
        </AuthButton>
      </form>
      <div className="mt-5 flex items-center gap-8">
        <div className="h-px flex-1 bg-slate-200" />
        <Text className="text-xl text-black">یا</Text>
        <div className="h-px flex-1 bg-slate-200" />
      </div>
      <div className="mt-5 flex flex-col-reverse gap-5 md:flex-row-reverse">
        <AuthButton
          type="button"
          onClick={() => go("/auth/forgot-password")}
          className="border border-infinity-primary !bg-transparent !text-infinity-primary"
          icon={<CodeIcon className="h-5 w-5 md:h-6 md:w-6" />}
        >
          فراموشی رمز عبور
        </AuthButton>
        <AuthButton
          type="button"
          onClick={() => void beginOtp()}
          className="border border-infinity-primary !bg-transparent !text-infinity-primary"
          icon={<OtpIcon className="h-5 w-5 md:h-6 md:w-6" />}
        >
          ورود با رمز یکبار مصرف
        </AuthButton>
      </div>
    </div>
  );
}

function OtpForm({
  mode,
  storefrontOrigin,
}: {
  mode: "login" | "register";
  storefrontOrigin: string;
}) {
  const { phone, flowReady, go } = useAuthFlow();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { timeLeft, active, restart } = useOtpCountdown();

  useEffect(() => {
    if (flowReady && !phone) go("/auth");
  }, [phone, flowReady, go]);

  const resend = async () => {
    if (active || !phone) return;
    setError("");
    try {
      await authPost("/infinity/otp/request", { phone });
      restart();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "خطا در ارسال کد تایید",
      );
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (code.length !== 6) return;
    setLoading(true);
    setError("");
    try {
      const response = await authPost<RedirectResponse>(
        "/infinity/otp/verify",
        {
          otp: code.split("").reverse().join(""),
        },
      );
      if (response.redirectTo.startsWith("/")) go(response.redirectTo);
      else routeToRedirect(response.redirectTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "کد تایید اشتباه است");
    } finally {
      setLoading(false);
    }
  };

  const title =
    mode === "register" ? "ایجاد حساب کاربری" : "ورود با رمز یکبار مصرف";
  return (
    <div className="space-y-8" dir="rtl">
      <AuthTitle
        subtitle={`لطفا کد ارسال شده به شماره همراه ${phone} را وارد نمایید`}
      >
        {title}
      </AuthTitle>
      <div>
        <AuthReturnButton href={storefrontOrigin} label="بازگشت به فروشگاه" />
      </div>
      <form onSubmit={submit} className="space-y-7">
        <div className="space-y-3">
          <Text variant="label">کدتایید شماره همراه</Text>
          <div className="flex flex-col items-end gap-4">
            <VerificationInput onChange={setCode} />
            <div className="flex w-full flex-row-reverse items-center justify-between">
              <span className="text-sm text-foreground-primary/80">
                {timeLeft}
              </span>
              <Text variant="helper">
                کد را دریافت نکردید؟{" "}
                <Text
                  variant="link"
                  onClick={() => void resend()}
                  disabled={active}
                >
                  ارسال مجدد
                </Text>
              </Text>
            </div>
          </div>
        </div>
        <ErrorAlert message={error} />
        <AuthButton
          type="submit"
          disabled={loading || code.length !== 6}
          icon={loading ? <Spinner /> : undefined}
        >
          {title}
        </AuthButton>
        {mode === "login" ? (
          <AuthButton
            type="button"
            onClick={() => go("/auth/login")}
            className="border border-infinity-primary !bg-transparent !text-infinity-primary"
          >
            ورود با رمز عبور
          </AuthButton>
        ) : null}
      </form>
    </div>
  );
}

export function OtpLoginForm(props: { storefrontOrigin: string }) {
  return <OtpForm mode="login" {...props} />;
}

export function RegistrationOtpForm(props: { storefrontOrigin: string }) {
  return <OtpForm mode="register" {...props} />;
}

export function ForgotPasswordForm() {
  const { setPhone, go } = useAuthFlow();
  const [phone, setPhoneValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!PHONE_PATTERN.test(phone)) {
      setError("شماره همراه وارد شده معتبر نیست");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setPhone(phone);
      await authPost("/infinity/otp/request", { phone });
      go("/auth/forgot-password/verify");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "کد تایید ارسال نشده است",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full">
      <button
        type="button"
        onClick={() => go("/auth")}
        className="text-sm text-infinity-primary"
      >
        بازگشت به ورود
      </button>
      <AuthTitle subtitle="لطفا شماره همراه خود را جهت بازیابی رمز وارد نمایید">
        بازیابی رمز عبور
      </AuthTitle>
      <form onSubmit={submit} className="mt-8 space-y-7" autoComplete="on">
        <div>
          <FieldLabel htmlFor="reset-phone" className="mb-2">
            شماره همراه
          </FieldLabel>
          <AuthInput
            id="reset-phone"
            name="phone"
            type="tel"
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhoneValue(event.target.value)}
            autoComplete="tel"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="next"
            error={error}
            placeholder="09122032114"
            required
            aria-required="true"
          />
        </div>
        <AuthButton
          type="submit"
          disabled={loading}
          icon={loading ? <Spinner /> : undefined}
        >
          تایید شماره همراه
        </AuthButton>
      </form>
    </div>
  );
}

export function ResetPasswordForm() {
  const { phone, flowReady, setPhone, go } = useAuthFlow();
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { timeLeft, active, restart } = useOtpCountdown();

  useEffect(() => {
    if (flowReady && !phone) go("/auth/forgot-password");
  }, [phone, flowReady, go]);

  const resend = async () => {
    if (active || !phone) return;
    try {
      await authPost("/infinity/otp/request", { phone });
      restart();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "خطا در ارسال کد تایید",
      );
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError("رمز عبور مطابقت ندارد");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await authPost("/infinity/password/reset", {
        otp: otp.split("").reverse().join(""),
        newPassword: password,
      });
      setPhone("");
      go("/auth");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "کد تایید یا توکن معتبر نیست",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full">
      <button
        type="button"
        onClick={() => go("/auth/forgot-password")}
        className="text-sm text-infinity-primary"
      >
        بازگشت
      </button>
      <AuthTitle
        subtitle={`لطفا کد تایید ارسال شده به شماره همراه ${phone} را وارد نمایید`}
      >
        بازیابی رمز عبور
      </AuthTitle>
      <form onSubmit={submit} className="mt-8 space-y-7" autoComplete="on">
        <div className="space-y-3">
          <Text variant="label">کدتایید شماره همراه</Text>
          <VerificationInput onChange={setOtp} />
          <div className="flex w-full flex-row-reverse items-center justify-between">
            <span className="text-sm text-foreground-primary/80">
              {timeLeft}
            </span>
            <Text variant="helper">
              کد را دریافت نکردید؟{" "}
              <Text
                variant="link"
                onClick={() => void resend()}
                disabled={active}
              >
                ارسال مجدد
              </Text>
            </Text>
          </div>
        </div>
        <div>
          <FieldLabel htmlFor="new-password" className="mb-2">
            رمز عبور
          </FieldLabel>
          <AuthPasswordInput
            id="new-password"
            name="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            showStrength
            autoComplete="new-password"
          />
        </div>
        <div>
          <FieldLabel htmlFor="confirm-new-password" className="mb-2">
            تکرار رمز عبور
          </FieldLabel>
          <AuthPasswordInput
            id="confirm-new-password"
            name="confirm-new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            error={
              confirmation && confirmation !== password
                ? "رمز عبور مطابقت ندارد"
                : undefined
            }
            autoComplete="new-password"
          />
        </div>
        <ErrorAlert message={error} />
        <AuthButton
          type="submit"
          disabled={
            loading ||
            otp.length !== 6 ||
            password.length < 6 ||
            confirmation !== password
          }
          icon={loading ? <Spinner /> : undefined}
        >
          تایید
        </AuthButton>
      </form>
    </div>
  );
}

export function RegistrationInfoForm() {
  const { phone, flowReady, go } = useAuthFlow();
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    birthYear: "",
    birthMonth: "",
    birthDay: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (flowReady && !phone) go("/auth");
  }, [phone, flowReady, go]);
  useEffect(() => {
    if (!flowReady || !phone) return;
    let cancelled = false;
    void authGet<{ FirstName?: string; LastName?: string }>("/infinity/profile")
      .then((profile) => {
        if (cancelled) return;
        setForm((current) => ({
          ...current,
          firstName: profile.FirstName?.trim() || current.firstName,
          lastName: profile.LastName?.trim() || current.lastName,
        }));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "بازیابی اطلاعات حساب ناموفق بود");
      });
    return () => { cancelled = true; };
  }, [phone, flowReady]);
  const change =
    (field: keyof typeof form) =>
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((current) => ({ ...current, [field]: event.target.value }));
  const birthDate = jalaliBirthDateToGregorianDate(
    form.birthYear,
    form.birthMonth,
    form.birthDay,
  );
  const hasBirthParts = Boolean(form.birthYear || form.birthMonth || form.birthDay);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim() || (hasBirthParts && !birthDate)) return;
    setLoading(true);
    setError("");
    try {
      const response = await authPost<RedirectResponse>(
        "/infinity/register-info",
        {
          firstName: form.firstName,
          lastName: form.lastName,
          birthDate: birthDate || null,
        },
      );
      routeToRedirect(response.redirectTo);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "خطا در ثبت اطلاعات. لطفا دوباره تلاش کنید",
      );
    } finally {
      setLoading(false);
    }
  };

  const ready = Boolean(
    form.firstName &&
      form.lastName &&
      (!hasBirthParts || birthDate),
  );
  return (
    <div className="space-y-8" dir="rtl">
      <AuthTitle subtitle="لطفا اطلاعات خود را تکمیل نمایید">
        ایجاد حساب کاربری
      </AuthTitle>
      <form onSubmit={submit} className="space-y-7" autoComplete="on">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 md:gap-6">
          <div>
            <FieldLabel htmlFor="first-name" className="mb-2">
              نام
            </FieldLabel>
            <AuthInput
              id="first-name"
              name="given-name"
              type="text"
              value={form.firstName}
              onChange={change("firstName")}
              placeholder="نام"
              autoComplete="given-name"
              required
            />
          </div>
          <div>
            <FieldLabel htmlFor="last-name" className="mb-2">
              نام خانوادگی
            </FieldLabel>
            <AuthInput
              id="last-name"
              name="family-name"
              type="text"
              value={form.lastName}
              onChange={change("lastName")}
              placeholder="نام خانوادگی"
              autoComplete="family-name"
              required
            />
          </div>
        </div>
        <div>
          <span id="birth-date-label" className="mb-2 inline-block">
            <Text variant="label">تاریخ تولد (اختیاری)</Text>
          </span>
          <div
            className="flex gap-2"
            role="group"
            aria-labelledby="birth-date-label"
          >
            <AuthInput
              id="birth-year"
              name="bday-year"
              type="number"
              value={form.birthYear}
              onChange={change("birthYear")}
              placeholder="سال (مثلا 1370)"
              min="1300"
              max="1450"
              autoComplete="bday-year"
              aria-label="سال تولد"
            />
            <AuthInput
              id="birth-month"
              name="bday-month"
              type="number"
              value={form.birthMonth}
              onChange={change("birthMonth")}
              placeholder="ماه (1-12)"
              min="1"
              max="12"
              autoComplete="bday-month"
              aria-label="ماه تولد"
            />
            <AuthInput
              id="birth-day"
              name="bday-day"
              type="number"
              value={form.birthDay}
              onChange={change("birthDay")}
              placeholder="روز (1-31)"
              min="1"
              max="31"
              autoComplete="bday-day"
              aria-label="روز تولد"
            />
          </div>
        </div>
        <div>
          <FieldLabel htmlFor="registration-phone" className="mb-2">
            شماره همراه
          </FieldLabel>
          <AuthInput
            id="registration-phone"
            name="phone"
            type="tel"
            dir="ltr"
            value={phone}
            autoComplete="tel"
            disabled
          />
        </div>
        <ErrorAlert message={error} />
        <AuthButton
          type="submit"
          disabled={loading || !ready}
          icon={loading ? <Spinner /> : undefined}
        >
          {loading ? "در حال ثبت نام..." : "ایجاد حساب کاربری"}
        </AuthButton>
      </form>
    </div>
  );
}
