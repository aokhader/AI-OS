import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The runner embeds the API and WebSocket on :4000 (docs/context/01-architecture.md §2).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
