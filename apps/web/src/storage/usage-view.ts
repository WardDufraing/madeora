/**
 * A storage pool as the storage pages show it (S15). Client-safe and pure, so the numbers and the
 * warning level are unit-tested.
 */
export interface StorageUsage {
  /** The pool's allowance in bytes. */
  readonly allowance: number;
  /** Bytes held by files in use. */
  readonly used: number;
  /** Bytes held by deleted files that can still be recovered (they count until purged). */
  readonly deleted: number;
  /** Bytes reserved by uploads in progress. */
  readonly reserved: number;
  /** The warning level the database last notified: none, 80% or 95%. */
  readonly warning: 0 | 80 | 95;
}

export interface StorageUsageRow {
  readonly allowance_bytes: number;
  readonly used_bytes: number;
  readonly deleted_bytes: number;
  readonly reserved_bytes: number;
  readonly warning_level: number;
}

export function toStorageUsage(row: StorageUsageRow): StorageUsage {
  const warning = row.warning_level === 95 ? 95 : row.warning_level === 80 ? 80 : 0;
  return {
    allowance: Math.max(0, row.allowance_bytes),
    used: Math.max(0, row.used_bytes),
    deleted: Math.max(0, row.deleted_bytes),
    reserved: Math.max(0, row.reserved_bytes),
    warning,
  };
}

/** Bytes that count against the allowance (in use and recoverable). */
export function countedBytes(usage: StorageUsage): number {
  return usage.used + usage.deleted;
}

/** What is still free; never below zero (a lowered allowance can leave a pool over it). */
export function availableBytes(usage: StorageUsage): number {
  return Math.max(0, usage.allowance - countedBytes(usage) - usage.reserved);
}

/** Share of the allowance counted, 0–100 (100 when the allowance is 0 and anything is stored). */
export function percentUsed(usage: StorageUsage): number {
  const counted = countedBytes(usage);
  if (usage.allowance === 0) return counted > 0 ? 100 : 0;
  return Math.min(100, Math.floor((counted * 100) / usage.allowance));
}

/** The level the page shows now, from the current numbers (the notified level can lag a moment). */
export function warningLevel(usage: StorageUsage): "none" | "warning" | "critical" | "full" {
  const percent = percentUsed(usage);
  if (percent >= 100) return "full";
  if (percent >= 95) return "critical";
  if (percent >= 80) return "warning";
  return "none";
}

const KIB = 1024;
const units = [
  { unit: "byte", size: 1 },
  { unit: "kilobyte", size: KIB },
  { unit: "megabyte", size: KIB ** 2 },
  { unit: "gigabyte", size: KIB ** 3 },
  { unit: "terabyte", size: KIB ** 4 },
] as const;

/** A byte count in the reader's language: "1 GB", "512 kB", "1,5 MB". Binary steps (1024). */
export function formatBytes(bytes: number, locale: string): string {
  const safe = Math.max(0, bytes);
  const step = [...units].reverse().find(({ size }) => safe >= size) ?? units[0];
  const value = safe / step.size;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: step.unit,
    unitDisplay: "short",
    maximumFractionDigits: value >= 100 || step.unit === "byte" ? 0 : 1,
  }).format(value);
}
