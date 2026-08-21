import type { Metadata } from "next";
import OrderDetailPageClient from "@/components/User/Orders/Detail/OrderDetailPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

interface OrderDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: OrderDetailPageProps): Promise<Metadata> {
  const { id: orderId } = await params;
  return {
    title: `جزئیات سفارش #${orderId}`,
    description: "وضعیت، پرداخت و اطلاعات ارسال سفارش خود را مشاهده و پیگیری کنید.",
    alternates: {
      canonical: `/orders/${orderId}`,
    },
  };
}

export default async function OrderDetailPage({ params }: OrderDetailPageProps) {
  const { id } = await params;
  return <OrderDetailPageClient orderId={id} />;
}
