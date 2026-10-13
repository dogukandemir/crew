import { useState } from 'react';
import { useCompanies, useHealth, useOnboardingState, useProjects } from '../../app/hooks';
import { CompaniesSection } from '../companies/CompaniesSection';
import { FoundCompanyWizard } from '../companies/FoundCompanyWizard';
import { GettingStarted } from '../companies/GettingStartedCard';
import { ExecutionModeControl } from '../onboarding/ExecutionModeControl';
import { OnboardingCard } from '../onboarding/OnboardingCard';
import {
  clearOnboardingDismissal,
  dismissOnboarding,
  onboardingDismissed,
  shouldShowOnboarding,
} from '../onboarding/onboarding';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatMicros } from '../../lib/format';
import { STAGE_LABELS } from './stageLabels';

const STATUS_TONE = {
  active: 'success',
  paused: 'warning',
  archived: 'muted',
  failed: 'danger',
} as const;

/**
 * Shown when no project tab is open — the empty state teaches (docs/09 §4). Since
 * ADR 0015 the path is company-first: found a company (wizard), then its projects;
 * a standalone project stays one click away.
 */
export function WelcomeScreen() {
  const projects = useProjects();
  const companies = useCompanies();
  const openTab = useTabs((s) => s.openTab);
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);
  const setToast = useUi((s) => s.setToast);
  const onboarding = useOnboardingState();
  const health = useHealth();
  const scenario = health.data?.version.endsWith('-mock');
  const demo = onboarding.data?.offline_llm || scenario;
  const [dismissed, setDismissed] = useState(() => onboardingDismissed());
  const [hideCard, setHideCard] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  // The wizard lives in the ui store: the Companies section and the welcome
  // CTAs all open THE SAME one — there is no second way to create a company.
  const wizardOpen = useUi((s) => s.foundWizardOpen);
  const setWizardOpen = useUi((s) => s.setFoundWizardOpen);
  const showCard = !scenario && (providerOpen || (!hideCard && !!health.data && !demo && onboarding.data?.offline_llm === false && shouldShowOnboarding(onboarding.data, dismissed)));

  const hasCompanies = (companies.data?.items.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-lg font-semibold text-slate-100">Crew control room</h1>
      <p className="mt-1 text-sm text-slate-400">
        Give your company a clear goal. Watch the team work in its office, review tasks and approvals,
        then inspect the files it delivers. Start with Demo or connect a provider for real work.
      </p>

      {!scenario && onboarding.data?.needed && dismissed && (
        <button
          type="button"
          onClick={() => {
            clearOnboardingDismissal();
            setDismissed(false);
            setHideCard(false);
          }}
          className="mt-3 rounded-full border border-amber-500/40 bg-amber-950/30 px-3 py-1 text-[11px] text-amber-200 hover:border-amber-400/60"
        >
          ⚠ No provider key yet — add one to run real agents
        </button>
      )}

      <ExecutionModeControl onConfigure={() => setProviderOpen(true)} />

      <GettingStarted
        demo={demo}
        providerReady={onboarding.data?.providers?.some(p => p.id === onboarding.data?.provider && p.configured) ?? false}
        companies={companies.data?.items.length ?? 0}
        projects={projects.data?.items.length ?? 0}
        runs={(projects.data?.items ?? []).reduce((n, p) => n + (p.runs ?? 0), 0)}
        onFound={() => setWizardOpen(true)}
        onNewProject={() => setNewProjectOpen(true)}
      />

      <CompaniesSection />

      <div className="mt-5 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-300">Projects</h2>
        {hasCompanies ? (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setWizardOpen(true)}>
              ⌂ Found another company
            </Button>
            <Button variant="primary" size="sm" onClick={() => setNewProjectOpen(true)}>
              ＋ New project
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setNewProjectOpen(true)}>
              ＋ Standalone project
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3">
        {projects.isLoading && <SkeletonRows rows={4} />}
        {projects.isError && (
          <PanelError error={projects.error} onRetry={() => void projects.refetch()} label="Project list" />
        )}
        {projects.isSuccess && projects.data.items.length === 0 && (
          <EmptyState
            title="No projects yet"
            description="A company holds the portfolio; a project is what its org works on. Found the company first — or start a standalone project."
            action={
              hasCompanies ? (
                <Button variant="primary" size="sm" onClick={() => setNewProjectOpen(true)}>
                  Create the first project
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={() => setWizardOpen(true)}>
                  ⌂ Found your first company
                </Button>
              )
            }
          />
        )}
        {projects.isSuccess && projects.data.items.length > 0 && (
          <ul className="divide-y divide-slate-800/70 overflow-hidden rounded-lg border border-slate-700/60">
            {projects.data.items.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => openTab(p.id, 'main', 'office')}
                >
                  <div className="flex items-center gap-2">
                    {p.company_name && (
                      <span
                        className="shrink-0 text-[10px] text-slate-500"
                        title={`Reports up to ${p.company_name}`}
                      >
                        ⌂ {p.company_name} ›
                      </span>
                    )}
                    <span className="truncate text-sm font-medium text-slate-100">{p.name}</span>
                    <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
                    {p.kind !== 'company' && <Badge tone="info">{STAGE_LABELS[p.stage] ?? p.stage}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{p.goal}</p>
                </button>
                <div className="shrink-0 text-right text-[11px] tabular-nums text-slate-400">
                  {formatMicros(p.spend_micros)}
                  <span className="text-slate-600"> / {formatMicros(p.budget_cap_micros)}</span>
                </div>
                <Button size="xs" onClick={() => openTab(p.id, 'main', 'office')}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showCard && onboarding.data && (
        <OnboardingCard
          state={onboarding.data}
          onDone={(detail) => {
            setHideCard(true);
            setProviderOpen(false);
            setToast({ kind: 'success', message: `Provider saved — ${detail}. Choose Live to run real agents.` });
            void onboarding.refetch();
          }}
          onSkip={() => {
            setProviderOpen(false);
            dismissOnboarding();
            setDismissed(true);
          }}
        />
      )}

      <FoundCompanyWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </div>
  );
}
