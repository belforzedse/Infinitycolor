import { RegistrationOtpForm } from "@/components/auth/forms";
import { getAuthEnv } from "@/server/env";

export default function RegisterPage() {
  return (
    <RegistrationOtpForm
      storefrontOrigin={getAuthEnv().defaultStorefrontOrigin}
    />
  );
}
