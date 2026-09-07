import LogoutCompleteClient from "./LogoutCompleteClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
export const instant = false;

export default function LogoutCompletePage() {
  return <LogoutCompleteClient />;
}
