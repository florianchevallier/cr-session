const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
});

// SQLite returns "YYYY-MM-DD HH:MM:SS" in UTC without a zone marker.
function parseDate(value: string): Date | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(value: string): string {
  const parsed = parseDate(value);
  return parsed ? dateFormatter.format(parsed) : value;
}

export function formatDateTime(value: string): string {
  const parsed = parseDate(value);
  return parsed
    ? `${dateFormatter.format(parsed)} · ${timeFormatter.format(parsed)}`
    : value;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export const SHORTCUT_KEY =
  typeof navigator !== "undefined" && navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
