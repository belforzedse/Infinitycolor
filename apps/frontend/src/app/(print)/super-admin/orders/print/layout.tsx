// app/(super-admin)/super-admin/orders/print/layout.tsx
import "./print.css";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return (
    // Full-viewport overlay to hide the rest of the app UI while on print routes
    <div>
      <div>{children}</div>
    </div>
  );
}
