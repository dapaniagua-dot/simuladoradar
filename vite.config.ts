import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'src/client',
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        login: resolve(__dirname, 'src/client/login.html'),
        dashboard: resolve(__dirname, 'src/client/dashboard.html'),
        admin: resolve(__dirname, 'src/client/admin.html'),
        misSesiones: resolve(__dirname, 'src/client/mis-sesiones.html'),
        sesion: resolve(__dirname, 'src/client/sesion.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@client': resolve(__dirname, 'src/client'),
    },
  },
});
