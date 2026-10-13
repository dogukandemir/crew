import { useMemo } from 'react';
import { cn } from '../../lib/cn';

/**
 * Hand-rolled sparkline (docs/09 §4 `components/ui` primitive).
 * Deliberately dependency-free: the metrics charts use recharts, but a table
 * cell needs an 80×20 SVG, not a charting library.
 */
export function Sparkline({
  values,
  width = 88,
  height = 22,
  tone,
  className,
  showArea = true,
}: {
  values: Array<number | null | undefined> | undefined;
  width?: number;
  height?: number;
  tone?: 'accent' | 'success' | 'danger';
  className?: string;
  showArea?: boolean;
}) {
  const series = useMemo(
    () => (values ?? []).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
    [values],
  );

  if (series.length < 2) {
    return <span className={cn('text-slate-600', className)}>—</span>;
  }

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const stepX = width / (series.length - 1);
  const pad = 2;

  const points = series.map((v, i) => {
    const x = i * stepX;
    const y = height - pad - ((v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  const first = series[0];
  const last = series[series.length - 1];
  const up = last >= first;
  const direction = last > first ? 'rising' : last < first ? 'falling' : 'flat';
  // Colour is not the only signal: the label spells the trend out.
  const trendLabel = `trend, ${series.length} points, ${briefNumber(first)} → ${briefNumber(last)}, ${direction}`;
  const stroke =
    tone === 'danger' ? '#fb7185' : tone === 'success' ? '#34d399' : up ? '#34d399' : '#fb7185';
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${d} L${width},${height} L0,${height} Z`;
  const id = `spark-${Math.abs(hash(series))}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
      role="img"
      aria-label={trendLabel}
    >
      {/* SVG-native tooltip: hover shows the same trend sentence. */}
      <title>{trendLabel}</title>
      {showArea && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id})`} stroke="none" />
        </>
      )}
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function hash(values: number[]): number {
  let h = 0;
  for (const v of values) h = (h * 31 + Math.round(v * 1000)) | 0;
  return h;
}

/** Endpoint formatting for the trend label: "0.58", "1.24", "12". */
function briefNumber(v: number): string {
  return String(Math.round(v * 100) / 100);
}
