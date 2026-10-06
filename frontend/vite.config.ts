import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tailwind v4 is wired in through the single @tailwindcss/vite plugin — no
// postcss.config, no tailwind.config needed (v4 configures itself in CSS).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    // Split the heavy vendors so the main bundle stays reviewable.
    rollupOptions: {
      output: {
        manualChunks: {
          flow: ['@xyflow/react'],
          charts: ['recharts'],
          state: ['@tanstack/react-query', 'zustand'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
