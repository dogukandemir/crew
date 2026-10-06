import { QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError, isBackendUnreachable } from '../api/client';
import { useUi } from '../stores/ui';

/**
 * One QueryClient for the app.
 *
 * Global rules:
 *  - a backend that is unreachable flips the "backend unreachable" banner on
 *    (docs/09 §3) instead of throwing the app into an error screen,
 *  - a successful call clears it,
 *  - 4xx domain errors (budget_exceeded, policy_denied, …) are NOT retried.
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (isBackendUnreachable(error)) {
        const detail = error instanceof ApiError ? error.message : String(error);
        useUi.getState().setBackendDown(true, detail);
      }
    },
    onSuccess: () => {
      if (useUi.getState().backendDown) useUi.getState().setBackendDown(false);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (isBackendUnreachable(error)) return failureCount < 1;
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
