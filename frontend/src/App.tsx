import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './app/queryClient';
import { SocketProvider } from './app/SocketProvider';
import { Shell } from './app/Shell';
import { AuthGate } from './app/AuthGate';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate><SocketProvider>
        <Shell />
      </SocketProvider></AuthGate>
    </QueryClientProvider>
  );
}

export default App;
