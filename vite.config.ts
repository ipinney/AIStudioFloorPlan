import path from 'path';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// No secrets are injected into the client bundle. The browser calls /api,
// which the dev server proxies to the API server (server/index.ts).
export default defineConfig({
    plugins: [tailwindcss()],
    server: {
        proxy: {
            '/api': {
                target: `http://127.0.0.1:${process.env.API_PORT || 8790}`,
                // Spark image jobs can queue behind other GPU work.
                timeout: 15 * 60 * 1000,
                proxyTimeout: 15 * 60 * 1000,
            },
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, '.'),
        },
    },
});
