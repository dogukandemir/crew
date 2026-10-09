import type { CompanyVerdictName } from '../../api/types';

/** One map for every verdict pill: the HQ floor, the portfolio and the review all
 * speak the same colours. */
export const VERDICT_TONE: Record<CompanyVerdictName, 'success' | 'warning' | 'muted' | 'danger'> = {
  on_track: 'success',
  at_risk: 'warning',
  no_activity: 'muted',
  stop: 'danger',
};
