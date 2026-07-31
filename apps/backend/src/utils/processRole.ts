export type ProcessRole = "web" | "worker" | "scheduler" | "cli";

const VALID_PROCESS_ROLES = new Set<ProcessRole>(["web", "worker", "scheduler", "cli"]);

function normalizeBoolean(value: string | undefined): boolean {
  return String(value || "false").toLowerCase() === "true";
}

export function getProcessRole(env: NodeJS.ProcessEnv = process.env): ProcessRole {
  const role = String(env.PROCESS_ROLE || "web").toLowerCase() as ProcessRole;
  return VALID_PROCESS_ROLES.has(role) ? role : "web";
}

export function isWebProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return getProcessRole(env) === "web";
}

export function shouldRunWebBootstrapMaintenance(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isWebProcess(env);
}

export function shouldStartInProcessBackgroundJobs(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isWebProcess(env)) {
    return false;
  }

  if (normalizeBoolean(env.DISABLE_BACKGROUND_JOBS)) {
    return false;
  }

  const command = argv.join(" ");
  return !/\b(build|ts:generate-types|generate-types)\b/.test(command);
}
