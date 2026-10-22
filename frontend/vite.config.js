import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  return {
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': {
        target: env.API_PROXY_TARGET || 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ''),
        configure(proxy) {
          if (env.VITE_DEPLOYMENT_TARGET !== 'cloudflare') return;
          proxy.on('proxyReq', (proxyReq, request) => {
            proxyReq.removeHeader('X-HireFlow-Access-Code');
            if (request.method === 'POST' && new URL(request.url, 'http://localhost').pathname === '/profile' && env.WORKSPACE_ACCESS_CODE) proxyReq.setHeader('X-HireFlow-Access-Code', env.WORKSPACE_ACCESS_CODE);
          });
        },
      },
    },
  },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/test/setup.js', css: true },
  };
});
