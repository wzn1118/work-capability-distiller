import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const apiTarget = process.env.KOLFORGE_API_TARGET
    || fileEnv.KOLFORGE_API_TARGET
    || `http://127.0.0.1:${process.env.KOLFORGE_PORT || fileEnv.KOLFORGE_PORT || '8787'}`;

  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) return 'vendor';
            return undefined;
          },
        },
      },
    },
    server: {
    // Collection artifacts and bundled analysis tools can update thousands of
    // files while a job is running. They are runtime data, not client source;
    // watching them causes an HMR reload storm that makes the workbench unusable.
    watch: {
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        '**/.kolforge-data/**',
        '**/.kolforge-data-*/**',
        '**/.kolforge-models/**',
        '**/.kolforge-runtime/**',
        '**/.kolforge-tools/**',
        '**/.persona-validation-data/**',
        '**/.persona-validation-logs/**',
        '**/output/**',
      ],
    },
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      },
    },
  };
});
