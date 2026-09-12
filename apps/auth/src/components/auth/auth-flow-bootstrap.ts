export type AuthBootstrapAction = "none" | "hydrate-flow" | "continue-session";
export type AuthBootstrapFailure = "credentials" | "retry";
export type AuthBootstrapStage = "flow" | "continuation";

interface AuthBootstrapInput {
  pathname: string;
  hasSessionCookie: boolean;
  stepUp: boolean;
  flowInitialized: boolean;
  sessionKnownAbsent: boolean;
}

export function authBootstrapAction({
  pathname,
  hasSessionCookie,
  stepUp,
  flowInitialized,
  sessionKnownAbsent,
}: AuthBootstrapInput): AuthBootstrapAction {
  if (pathname === "/auth/forgot-password") return "none";

  if (pathname === "/auth") {
    if (stepUp || sessionKnownAbsent || !hasSessionCookie) return "none";
    return "continue-session";
  }

  return flowInitialized ? "none" : "hydrate-flow";
}

export function classifyBootstrapFailure(
  stage: "flow",
  status: number,
): "retry";
export function classifyBootstrapFailure(
  stage: "continuation",
  status: number,
): AuthBootstrapFailure;
export function classifyBootstrapFailure(
  stage: AuthBootstrapStage,
  status: number,
): AuthBootstrapFailure {
  return stage === "continuation" && status === 401 ? "credentials" : "retry";
}
