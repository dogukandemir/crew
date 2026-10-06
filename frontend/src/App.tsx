import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './app/queryClient';
import { SocketProvider } from './app/SocketProvider';
import { Shell } from './app/Shell';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SocketProvider>
        <Shell />
      </SocketProvider>
    </QueryClientProvider>
  );
}

export default App;
