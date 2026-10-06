import { useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Minimal windowed list (docs/09 §2.8 "virtualized, filterable firehose").
 * Renders only the visible slice plus an overscan margin — enough for a
 * 5 000-row event buffer without pulling in a virtualization library.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  height,
  render,
  keyOf,
  overscan = 10,
  className,
  empty,
}: {
  items: T[];
  rowHeight: number;
  height: number;
  render: (item: T, index: number) => ReactNode;
  keyOf: (item: T, index: number) => string;
  overscan?: number;
  className?: string;
  empty?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  if (items.length === 0) {
    return <div className={cn('overflow-auto', className)} style={{ height }}>{empty}</div>;
  }

  const total = items.length * rowHeight;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(height / rowHeight) + overscan * 2;
  const end = Math.min(items.length, start + visibleCount);
  const slice = items.slice(start, end);

  return (
    <div
      ref={ref}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      className={cn('overflow-auto', className)}
      style={{ height }}
    >
      <div style={{ height: total, position: 'relative' }}>
        <div style={{ transform: `translateY(${start * rowHeight}px)` }}>
          {slice.map((item, i) => {
            const index = start + i;
            return (
              <div key={keyOf(item, index)} style={{ height: rowHeight }}>
                {render(item, index)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
