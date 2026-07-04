import type { NodeType } from "./api";

// Validated categorical palette (dataviz reference instance).
// Slot order is the CVD-safety mechanism: fixed, never cycled.
export const SERIES_LIGHT = [
  "#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834",
] as const;
export const SERIES_DARK = [
  "#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926",
] as const;

// Sequential blue ramp, light -> dark (heatmap magnitude).
export const SEQ_LIGHT = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"] as const;
export const SEQ_DARK = ["#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5"] as const;

// Status palette (fixed, never themed, never reused as series).
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

// Fixed assignment: first eight node types own categorical slots, in schema
// enum order; the rest fold into a neutral "other" (identity carried by label).
export const NODE_TYPE_ORDER: NodeType[] = [
  "entity", "project", "pattern", "domain", "person", "infrastructure", "claim", "decision",
  "task", "question", "community", "view",
];

export const OTHER_LIGHT = "#898781";
export const OTHER_DARK = "#a3a29b";

export function typeColor(type: NodeType, dark: boolean): string {
  const slot = NODE_TYPE_ORDER.indexOf(type);
  const series = dark ? SERIES_DARK : SERIES_LIGHT;
  if (slot >= 0 && slot < series.length) return series[slot];
  return dark ? OTHER_DARK : OTHER_LIGHT;
}

export function seqColor(value: number, max: number, dark: boolean): string {
  const ramp = dark ? SEQ_DARK : SEQ_LIGHT;
  if (max <= 0 || value <= 0) return "transparent";
  const idx = Math.min(ramp.length - 1, Math.floor((value / max) * ramp.length));
  return ramp[idx];
}

export function formatDay(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatWhen(iso: string): string {
  const then = new Date(iso);
  const deltaMs = Date.now() - then.getTime();
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Fill missing days so time axes keep honest spacing.
export function fillDays(
  rows: Array<{ date: string; total: number; writes: number }>,
  spanDays: number,
): Array<{ date: string; total: number; writes: number }> {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const out: Array<{ date: string; total: number; writes: number }> = [];
  const today = new Date();
  for (let i = spanDays - 1; i >= 0; i -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    const key = day.toISOString().slice(0, 10);
    out.push(byDate.get(key) ?? { date: key, total: 0, writes: 0 });
  }
  return out;
}
