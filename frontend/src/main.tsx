import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './index.css';
import { App } from './App';
import { ErrorBoundary } from './app/ErrorBoundary';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Crew: #root container is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    {/* Outside the app, so a throw anywhere inside it still leaves something on screen. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
