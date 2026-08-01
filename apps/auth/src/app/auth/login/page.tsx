import { PasswordLoginForm } from "@/components/auth/forms";
import { getAuthEnv } from "@/server/env";

export default function LoginPage() {
  return (
    <PasswordLoginForm
      storefrontOrigin={getAuthEnv().defaultStorefrontOrigin}
    />
  );
}
