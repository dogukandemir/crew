import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useHealth, useOnboardingState } from '../../app/hooks';
import { Button } from '../../components/ui/Button';
import { ProviderStatus } from './ProviderStatus';

export function ExecutionModeControl({ onConfigure }: { onConfigure: () => void }) {
  const { data } = useOnboardingState();
  const health = useHealth();
  const connected = data?.providers?.some(p => p.id === data.provider && p.configured) ?? false;
  const cache = useQueryClient();
  const change = useMutation({
    mutationFn: (mode: 'demo' | 'live') => api.setExecutionMode(mode),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: ['onboarding'] }); void cache.invalidateQueries({ queryKey: ['health'] }); },
  });
  if (!data) return null;
  if (health.data?.version.endsWith('-mock')) return <section className="my-5 rounded-lg border border-amber-800 p-4" aria-label="Demo scenario">
    <p className="font-medium text-amber-100">Demo scenario, simulated company</p>
    <p className="mt-1 text-sm text-slate-300">Explore the office, agent activity and results. This scenario uses fictional work and costs, with no model requests.</p>
  </section>;
  return <section className="my-5 space-y-3 rounded-lg border border-slate-700 p-4" aria-label="Execution mode">
    <p className="font-medium">{data.offline_llm ? 'Demo, explore with simulated work' : 'Live, real agents and real deliverables'}</p>
    <div className="flex flex-wrap items-center gap-2"><ProviderStatus state={data} /><span className="text-xs text-slate-400">{data.model}</span></div>
    <p className="text-xs text-slate-400">{data.offline_llm
      ? 'Demo makes no model requests and costs nothing in provider usage. Connect a provider, then switch to Live when ready.'
      : 'Your selected provider receives agent context. Model usage can cost money. Each project has spending limits and approval controls.'}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={onConfigure}>{connected ? 'Manage provider' : 'Configure provider'}</Button>
      <Button size="sm" loading={change.isPending} disabled={data.offline_llm && !connected} onClick={() => change.mutate(data.offline_llm ? 'live' : 'demo')}>
        {data.offline_llm ? 'Enable Live · usage may cost money' : 'Switch to Demo'}
      </Button>
    </div>
    {data.offline_llm && !connected && <p className="text-xs text-slate-300">Demo is ready to explore. Connect a provider when you want to enable Live.</p>}
    {change.isError && <p className="text-xs text-rose-300" role="alert">{change.error.message}</p>}
  </section>;
}
