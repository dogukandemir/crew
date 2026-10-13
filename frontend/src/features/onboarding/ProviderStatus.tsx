import type { OnboardingState } from '../../api/types';
import { Badge } from '../../components/ui/Badge';
import { providerLabel } from './onboarding';

/** Credential presence is independent of whether Demo or Live is selected. */
export function ProviderStatus({ state, unavailable = false }: { state?: OnboardingState; unavailable?: boolean }) {
  if (!state) return <Badge tone="muted">{unavailable ? 'Provider status unavailable' : 'Checking provider…'}</Badge>;
  const selected = state.providers?.find(p => p.id === state.provider);
  const label = selected?.label ?? (state.provider ? providerLabel(state.provider) : 'Provider');
  return <span title={`Selected model: ${state.model}. ${state.offline_llm ? 'Demo does not use this provider.' : 'Live runs use this provider.'}`}>
    <Badge tone={selected?.configured ? 'success' : 'warning'}>
      {label} {selected?.configured ? 'connected' : 'not connected'}
    </Badge>
  </span>;
}
