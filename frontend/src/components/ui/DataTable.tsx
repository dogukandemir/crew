import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Provide to make the column sortable. */
  sortValue?: (row: T) => number | string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  width?: string;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  sort,
  onSortChange,
  empty,
  loading,
  rowClassName,
  className,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  empty?: ReactNode;
  loading?: boolean;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
}) {
  const alignClass = (a?: Column<T>['align']) =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  // Sorting lives here so every table gets it for free when a Column supplies
  // `sortValue` and the caller owns the `sort` state.
  const ordered = (() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv)) * factor;
    });
  })();

  return (
    <div className={cn('overflow-auto rounded-lg border border-slate-700/60', className)}>
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-900/95 text-slate-400 backdrop-blur">
          <tr>
            {columns.map((col) => {
              const sortable = !!col.sortValue && !!onSortChange;
              const active = sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    'border-b border-slate-700/60 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide',
                    alignClass(col.align),
                    col.className,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-slate-100"
                      onClick={() =>
                        onSortChange({
                          key: col.key,
                          dir: active && sort?.dir === 'asc' ? 'desc' : 'asc',
                        })
                      }
                    >
                      {col.header}
                      <span aria-hidden className={active ? 'text-emerald-300' : 'text-slate-600'}>
                        {active && sort?.dir === 'desc' ? '▾' : '▴'}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && ordered.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-slate-500">
                Loading…
              </td>
            </tr>
          )}
          {!loading && ordered.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-2">
                {empty ?? <div className="py-4 text-center text-slate-500">No rows.</div>}
              </td>
            </tr>
          )}
          {ordered.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter') onRowClick(row);
                    }
                  : undefined
              }
              className={cn(
                'border-b border-slate-800/70 last:border-0',
                onRowClick && 'cursor-pointer hover:bg-slate-800/50',
                rowClassName?.(row),
              )}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn('px-2.5 py-1.5 align-middle text-slate-200', alignClass(col.align), col.className)}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
