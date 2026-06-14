import { resolvePaymentGateway } from "@/utils/paymentGateways";

interface PaymentGatewayBadgeProps {
  /** Raw gateway value (backend Code/Title, English or Persian). */
  gateway?: string | null;
  /** Icon size in px. */
  size?: number;
  className?: string;
}

/**
 * Reusable label + icon for a payment gateway. Resolves the raw value to a Persian
 * label and official icon via the central map. Unknown/empty gateways degrade to a
 * label-only badge (no broken icon).
 */
export default function PaymentGatewayBadge({
  gateway,
  size = 18,
  className = "",
}: PaymentGatewayBadgeProps) {
  const meta = resolvePaymentGateway(gateway);
  const label = meta?.label ?? (gateway ?? "").toString().trim() ?? "";

  if (!label && !meta) return null;

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {meta ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={meta.icon}
          alt=""
          aria-hidden="true"
          width={size}
          height={size}
          className="inline-block shrink-0 object-contain"
        />
      ) : null}
      <span>{label || "نامشخص"}</span>
    </span>
  );
}
