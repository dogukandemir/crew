import type { DeliverableRow } from '../../api/types';

export function latestFiles(rows: DeliverableRow[]): DeliverableRow[] {
  const ordered = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const seen = new Set<string>();
  return ordered.filter(row => {
    const key = JSON.stringify([row.project_id, row.kind, row.name]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
