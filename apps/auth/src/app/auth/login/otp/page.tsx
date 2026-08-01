import { OtpLoginForm } from "@/components/auth/forms";
import { getAuthEnv } from "@/server/env";

export default function OtpLoginPage() {
  return (
    <OtpLoginForm storefrontOrigin={getAuthEnv().defaultStorefrontOrigin} />
  );
}
