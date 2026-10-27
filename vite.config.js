import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const backendUrl =
    env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';

  const wsTarget =
    env.VITE_WS_URL || backendUrl.replace(/^http/, 'ws');

  const sfuWsTarget =
    env.VITE_SFU_WS_URL || 'ws://127.0.0.1:3088';

  return {
    plugins: [
      react(),
      basicSsl(),
    ],

    define: {
      'process.env.IS_PREACT': JSON.stringify('false'),
    },

    server: {
      host: '0.0.0.0',
      port: 5173,
      https: true,

      proxy: {
        '/ws': {
          target: wsTarget,
          ws: true,
          changeOrigin: true,
        },

        '/rtc-ws': {
          target: sfuWsTarget,
          ws: true,
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(/^\/rtc-ws/, '') || '/',
        },

        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  };
});