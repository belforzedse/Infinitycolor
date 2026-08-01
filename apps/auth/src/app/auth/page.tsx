import { PhoneStatusForm } from "@/components/auth/forms";
import { getAuthEnv } from "@/server/env";

export default function AuthPage() {
  return (
    <PhoneStatusForm storefrontOrigin={getAuthEnv().defaultStorefrontOrigin} />
  );
}
