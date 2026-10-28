import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
import path from 'path';

/**
 * Custom Vite Plugin: Intercepts client logs from iPad/browsers via /__client_log
 * and prints them formatted directly in the shell terminal running `npm run client`.
 */
function clientLoggerPlugin() {
  return {
    name: 'client-logger',
    configureServer(server) {
      server.middlewares.use('/__client_log', (req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const tag = data.tag || 'CLIENT';
            const ua = data.ua || 'Browser';
            const time = data.time || '';
            const msg = data.msg || '';
            const details =
              data.details && Object.keys(data.details).length > 0
                ? JSON.stringify(data.details)
                : '';

            const logLine = `[${time}] [${ua}] [${tag}] ${msg} ${details}`;
            const colorUa = ua.includes('iPad') ? '\x1b[35m' : '\x1b[36m';
            console.log(
              `\x1b[90m[${time}]\x1b[0m ${colorUa}[${ua}]\x1b[0m \x1b[33m[${tag}]\x1b[0m \x1b[1m${msg}\x1b[0m \x1b[32m${details}\x1b[0m`
            );
            fs.appendFileSync(path.resolve(process.cwd(), 'client_debug.log'), logLine + '\n');
          } catch {
            console.log(`\x1b[33m[CLIENT LOG]\x1b[0m ${body}`);
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain');
          res.end('ok');
        });
      });
    },
  };
}

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
      clientLoggerPlugin(),
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

        '/sfu-dashboard': {
          target: sfuWsTarget.replace(/^ws/, 'http'),
          changeOrigin: true,
          rewrite: () => '/dashboard',
        },

        '/sfu': {
          target: sfuWsTarget.replace(/^ws/, 'http'),
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(/^\/sfu/, '') || '/',
        },

        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  };
});