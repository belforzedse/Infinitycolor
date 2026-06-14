export function maskSecret(value?: string | null): string {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.length <= 8) return "***";
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

export function maskPhone(value?: string | null): string {
  const raw = String(value || "");
  if (!raw) return "";
  const normalized = raw.replace(/\s+/g, "");
  if (/^\+98\d{10}$/.test(normalized)) {
    return `+98****${normalized.slice(-4)}`;
  }
  const match = normalized.match(/^(\+?\d{2,3})(\d+)(\d{4})$/);
  if (!match) return "***";
  return `${match[1]}****${match[3]}`;
}
