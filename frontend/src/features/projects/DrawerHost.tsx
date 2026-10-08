import { useUi } from '../../stores/ui';
import { AgentDrawer } from '../agents/AgentDrawer';
import { CommandDrawer } from '../commands/CommandDrawer';
import { TaskDrawer } from '../tasks/TaskDrawer';

/**
 * Central drawer host: any panel can `openDrawer(tabId, {kind:'agent'|'task'})`
 * and the right drawer renders here (unit drawers are owned by the org chart,
 * which has the tree in hand).
 */
export function DrawerHost({ projectId, tabId }: { projectId: string; tabId: string }) {
  const drawer = useUi((s) => s.drawers[tabId]);
  const closeDrawer = useUi((s) => s.closeDrawer);

  if (!drawer) return null;
  if (drawer.kind === 'agent') {
    return (
      <AgentDrawer
        agentId={drawer.id}
        projectId={projectId}
        onClose={() => closeDrawer(tabId)}
      />
    );
  }
  if (drawer.kind === 'task') {
    return <TaskDrawer taskId={drawer.id} projectId={projectId} onClose={() => closeDrawer(tabId)} />;
  }
  if (drawer.kind === 'command') {
    return <CommandDrawer projectId={projectId} onClose={() => closeDrawer(tabId)} />;
  }
  return null;
}
