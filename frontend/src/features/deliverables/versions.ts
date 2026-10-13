import type { DeliverableRow } from '../../api/types';

export function latestFiles(rows: DeliverableRow[]): DeliverableRow[] {
  const ordered = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const seen = new Set<string>();
  return ordered.filter(row => {
    // The agent is part of the file's identity: two agents publishing 'summary.md' in one
    // project are two files, not one (review 2026-10-14).
    const key = JSON.stringify([row.project_id, row.kind, row.name, row.agent_id ?? row.agent_name ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
