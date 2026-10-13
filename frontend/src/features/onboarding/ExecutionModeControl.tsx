import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useOnboardingState } from '../../app/hooks';
import { Button } from '../../components/ui/Button';
import { ProviderStatus } from './ProviderStatus';

export function ExecutionModeControl({ onConfigure }: { onConfigure: () => void }) {
  const { data } = useOnboardingState();
  const connected = data?.providers?.some(p => p.id === data.provider && p.configured) ?? false;
  const cache = useQueryClient();
  const change = useMutation({
    mutationFn: (mode: 'demo' | 'live') => api.setExecutionMode(mode),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: ['onboarding'] }); void cache.invalidateQueries({ queryKey: ['health'] }); },
  });
  if (!data) return null;
  return <section className="my-5 space-y-3 rounded-lg border border-slate-700 p-4" aria-label="Execution mode">
    <p className="font-medium">{data.offline_llm ? 'Demo — explore with simulated work' : 'Live — real agents and real deliverables'}</p>
    <div className="flex flex-wrap items-center gap-2"><ProviderStatus state={data} /><span className="text-xs text-slate-400">{data.model}</span></div>
    <p className="text-xs text-slate-400">{data.offline_llm
      ? 'Demo makes no model requests and costs nothing in provider usage. Connect a provider, then switch to Live when ready.'
      : 'Your selected provider receives agent context. Model usage can cost money. Each project has spending limits and approval controls.'}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={onConfigure}>{connected ? 'Manage provider' : 'Configure provider'}</Button>
      <Button size="sm" loading={change.isPending} onClick={() => change.mutate(data.offline_llm ? 'live' : 'demo')}>
        {data.offline_llm ? 'Enable Live · usage may cost money' : 'Switch to Demo'}
      </Button>
    </div>
    {change.isError && <p className="text-xs text-rose-300" role="alert">{change.error.message}</p>}
  </section>;
}
