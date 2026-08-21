import { config } from "./config";
import UpsertPageContentWrapper from "@/components/SuperAdmin/UpsertPage/ContentWrapper/index";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export type PaymentMethod = {
  id: number;
  name: string;
  accessLevel: string;
  apiKey: string;
  returnUrl: string;
  description: string;
  configJSON: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export default function Page() {
  return <UpsertPageContentWrapper<PaymentMethod> config={config} />;
}
