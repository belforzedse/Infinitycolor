export function checkTargets(
  origins: Record<string, string>,
  options?: { allowHosts?: string },
): { ok: true } | { ok: false; problems: string[] };

export function assertSafeTargets(
  origins: Record<string, string>,
  options?: { allowHosts?: string },
): void;
