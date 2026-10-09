import { useState } from 'react';
import { cn } from '../../lib/cn';
import {
  allDone,
  gettingStartedSteps,
  type GettingStartedStep,
} from './gettingStarted';

const STORAGE_KEY = 'crew.gettingStarted.dismissed';

/**
 * The welcome checklist (ADR 0015): four honest steps, each reading the record.
 * It disappears when everything is done — or when you say so; it never nags.
 */
export function GettingStarted({
  providerReady,
  companies,
  projects,
  runs,
  onFound,
  onNewProject,
}: {
  providerReady: boolean;
  companies: number;
  projects: number;
  runs: number;
  onFound: () => void;
  onNewProject: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const steps = gettingStartedSteps({ providerReady, companies, projects, runs });
  if (dismissed || allDone(steps)) return null;

  const doneCount = steps.filter((s) => s.done).length;

  const actionFor = (step: GettingStartedStep) => {
    if (step.done) return null;
    if (step.key === 'provider') return null; // the onboarding card (above) owns this
    if (step.key === 'company')
      return { label: 'Found it →', run: onFound };
    if (step.key === 'project')
      return { label: 'New project →', run: onNewProject };
    return null;
  };

  return (
    <section className="mt-5 overflow-hidden rounded-lg border border-slate-700/60 bg-slate-900/40">
      <div className="flex items-center gap-2 border-b border-slate-800/70 px-3 py-2">
        <span className="text-xs font-medium text-slate-200">Getting started</span>
        <span className="text-[11px] tabular-nums text-slate-500">
          {doneCount}/{steps.length}
        </span>
        <button
          type="button"
          className="ml-auto text-[11px] text-slate-500 underline decoration-dotted hover:text-slate-300"
          onClick={() => {
            try {
              window.localStorage.setItem(STORAGE_KEY, '1');
            } catch {
              /* private mode — dismissing is best-effort */
            }
            setDismissed(true);
          }}
        >
          hide
        </button>
      </div>
      <ul className="divide-y divide-slate-800/60">
        {steps.map((s) => {
          const action = actionFor(s);
          return (
            <li key={s.key} className="flex items-center gap-3 px-3 py-2">
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px]',
                  s.done
                    ? 'border-emerald-500/60 bg-emerald-950/60 text-emerald-300'
                    : 'border-slate-600/70 text-slate-600',
                )}
                aria-hidden
              >
                {s.done ? '✓' : ''}
              </span>
              <div className="min-w-0 flex-1">
                <span className={cn('text-xs', s.done ? 'text-slate-500 line-through' : 'text-slate-200')}>
                  {s.label}
                </span>
                {!s.done && <p className="truncate text-[11px] text-slate-500">{s.hint}</p>}
              </div>
              {action && (
                <button
                  type="button"
                  onClick={action.run}
                  className="shrink-0 text-[11px] text-emerald-300/90 underline decoration-dotted hover:text-emerald-200"
                >
                  {action.label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
