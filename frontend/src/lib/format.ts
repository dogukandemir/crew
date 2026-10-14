/**
 * Formatters (docs/09 §3 "never lie": unknown renders as "—").
 *
 * Money is micro-USD integers everywhere on the wire (docs/10, docs/11 §1):
 * 1_240_000 micros === $1.24.
 */

export const MICROS_PER_USD = 1_000_000;

const UNKNOWN = '—';

export function microsToUsd(micros: number | null | undefined): number {
  if (micros === null || micros === undefined || !Number.isFinite(micros)) return 0;
  return micros / MICROS_PER_USD;
}

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(usd * MICROS_PER_USD);
}

export interface UsdOptions {
  /** Fixed fraction digits; when omitted, small non-zero amounts get 4. */
  decimals?: number;
  signed?: boolean;
}

export function formatUsd(usd: number | null | undefined, opts: UsdOptions = {}): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return UNKNOWN;
  const value = usd;
  const decimals =
    opts.decimals ?? (value !== 0 && Math.abs(value) < 0.01 ? 4 : 2);
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  return opts.signed && value > 0 ? `+${formatted}` : formatted;
}

/** Format a micro-USD integer as USD, with sane precision for tiny amounts. */
export function formatMicros(
  micros: number | null | undefined,
  opts: UsdOptions = {},
): string {
  if (micros === null || micros === undefined || !Number.isFinite(micros)) return UNKNOWN;
  const usd = microsToUsd(micros);
  const decimals =
    opts.decimals ?? (usd !== 0 && Math.abs(usd) < 0.01 ? 4 : 2);
  return formatUsd(usd, { ...opts, decimals });
}

/** Alias kept so call sites read naturally next to `cost_micros`. */
export const formatMoney = formatMicros;

/** 1234 → "1.2k", 1_234_567 → "1.2M", 999 → "999". */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 1000) return `${n}`;
  if (abs < 1_000_000) return `${sign}${trim(n / 1000)}k`;
  if (abs < 1_000_000_000) return `${sign}${trim(n / 1_000_000)}M`;
  return `${sign}${trim(n / 1_000_000_000)}B`;
}

function trim(value: number): string {
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatPercent(
  fraction: number | null | undefined,
  decimals = 0,
): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return UNKNOWN;
  return `${(fraction * 100).toFixed(decimals)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNKNOWN;
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (abs < 3_600_000) {
    const m = Math.floor(abs / 60_000);
    const s = Math.round((abs % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(abs / 3_600_000);
  const m = Math.round((abs % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

/** "just now" / "12s ago" / "3m ago" / "2h ago" / "5d ago". */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return UNKNOWN;
  const ts = parseTs(iso);
  if (Number.isNaN(ts)) return UNKNOWN;
  const delta = now - ts;
  if (delta < 0) {
    const ahead = Math.abs(delta);
    if (ahead < 60_000) return 'in a moment';
    return `in ${Math.round(ahead / 60_000)}m`;
  }
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/**
 * Parse an API timestamp to epoch ms. The backend sends a UTC offset on every
 * wire timestamp (core/events.utc_iso), but be defensive about old rows and
 * hand-made fixtures: a naive string (no `Z`/offset) is UTC by contract —
 * `Date.parse` alone would read it as LOCAL time and shift history by the
 * machine's UTC offset (the "fresh event, 2h ago" bug).
 */
export function parseTs(iso: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  return Date.parse(hasZone ? iso : `${iso}Z`);
}

/** Local wall-clock HH:MM:SS from an ISO timestamp. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return UNKNOWN;
  const d = new Date(parseTs(iso));
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return UNKNOWN;
  const d = new Date(parseTs(iso));
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toLocaleString('en-GB', { hour12: false });
}

/** Budget meter helper: fraction of cap consumed, clamped to [0, 1]. */
export function budgetFraction(
  spendMicros: number | null | undefined,
  capMicros: number | null | undefined,
): number {
  const spend = spendMicros ?? 0;
  const cap = capMicros ?? 0;
  if (!cap || cap <= 0) return 0;
  return Math.max(0, Math.min(1, spend / cap));
}

/** A required-skill ref: the backend ships {skill, weight} objects (docs/03 §1);
 * plain strings are tolerated so a stale payload can never crash the renderer. */
export function skillLabel(s: { skill: string; weight?: number } | string): string {
  if (typeof s === 'string') return s;
  return typeof s.weight === 'number' && s.weight !== 1 ? `${s.skill} ×${s.weight}` : s.skill;
}

export { UNKNOWN };
