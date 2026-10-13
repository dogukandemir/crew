import { Select } from '../../components/ui/Field';
import { TabBar } from '../../components/ui/Tabs';
import { WORKSPACE_TAB_LABEL, type WorkspaceTab } from '../../stores/tabs';

export function WorkspaceNavigation({ allowed, current, onChange }: {
  allowed: readonly WorkspaceTab[]; current: WorkspaceTab; onChange: (tab: WorkspaceTab) => void;
}) {
  const primary = allowed.filter(tab => ['office', 'overview', 'tasks', 'deliverables', 'hq', 'projects'].includes(tab));
  const more = allowed.filter(tab => !primary.includes(tab));
  return <div className="flex min-w-0 flex-1 items-center gap-2">
    <TabBar tabs={primary.map(id => ({ id, label: WORKSPACE_TAB_LABEL[id] }))} value={current}
      onChange={onChange} label="Main workspace views" className="min-w-0 flex-1" />
    <Select aria-label="More workspace views" value={more.includes(current) ? current : ''}
      className="w-32 shrink-0 py-1 text-xs" onChange={event => { if (event.target.value) onChange(event.target.value as WorkspaceTab); }}>
      <option value="">More views…</option>
      {more.map(id => <option key={id} value={id}>{WORKSPACE_TAB_LABEL[id]}</option>)}
    </Select>
  </div>;
}
