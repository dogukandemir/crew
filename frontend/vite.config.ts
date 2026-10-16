import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tailwind v4 is wired in through the single @tailwindcss/vite plugin, no
// postcss.config, no tailwind.config needed (v4 configures itself in CSS).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // Split the heavy vendors so the main bundle stays reviewable.
    // Vite 8 bundles with Rolldown: `build.rollupOptions` is deprecated (alias of
    // `rolldownOptions`) and the object form of `output.manualChunks` is gone,
    // vendor splitting is now expressed as `output.codeSplitting.groups`.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'flow', test: /node_modules[\\/]@xyflow[\\/]/ },
            { name: 'charts', test: /node_modules[\\/](recharts|victory-vendor|d3-[^\\/]+)[\\/]/ },
            { name: 'state', test: /node_modules[\\/](@tanstack[\\/]react-query|zustand)[\\/]/ },
          ],
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
