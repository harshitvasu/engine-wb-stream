import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://192.168.1.9:3001',
        ws: true,
      },
      '/api': {
        target: 'http://192.168.1.9:3001',
      },
    },
  },
});
