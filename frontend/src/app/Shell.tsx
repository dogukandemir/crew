import { useEffect } from 'react';
import { Header } from './Header';
import { TabStrip } from '../features/projects/TabStrip';
import { ProjectWorkspace } from '../features/projects/ProjectWorkspace';
import { WelcomeScreen } from '../features/projects/WelcomeScreen';
import { NewProjectDialog } from '../features/projects/NewProjectDialog';
import { ApprovalTray } from '../features/approvals/ApprovalTray';
import { BackendBanner } from '../components/PanelError';
import { Toaster } from '../components/Toaster';
import { useTabs } from '../stores/tabs';

/**
 * The shell (docs/09 §1): header, tab strip (tabs = projects), the active
 * project's workspace, the persistent approval tray.
 */
export function Shell() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const setActive = useTabs((s) => s.setActive);
  const clearBadge = useTabs((s) => s.clearBadge);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // If the active tab was closed (or never set), fall back to the first one.
  useEffect(() => {
    if (!activeTab && tabs.length > 0) setActive(tabs[0].id);
  }, [activeTab, tabs, setActive]);

  useEffect(() => {
    if (activeTabId) clearBadge(activeTabId);
  }, [activeTabId, clearBadge]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      <Header />
      <BackendBanner />
      <TabStrip />
      <main className="min-h-0 flex-1 overflow-hidden">
        {activeTab ? (
          // Keyed by tab id: each tab keeps its own view, filters and scroll.
          <ProjectWorkspace key={activeTab.id} tab={activeTab} />
        ) : (
          <div className="h-full overflow-y-auto">
            <WelcomeScreen />
          </div>
        )}
      </main>
      <ApprovalTray />
      <NewProjectDialog />
      <Toaster />
    </div>
  );
}
