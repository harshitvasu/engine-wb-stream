import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:3001';
  const wsTarget = env.VITE_WS_URL || backendUrl.replace(/^http/, 'ws');

  return {
    plugins: [react()],
    define: {
      'process.env.IS_PREACT': JSON.stringify('false'),
    },
    server: {
      host: '0.0.0.0', // Allow connections from your local network
      port: 5173,
      proxy: {
        '/ws': {
          target: wsTarget,
          ws: true,
          changeOrigin: true,
        },
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
