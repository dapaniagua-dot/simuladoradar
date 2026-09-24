import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

// El proxy apunta al mismo PORT que usa el backend (.env), así se puede mover
// el server si el 3000 está ocupado por otro proyecto local.
const env = loadEnv('development', __dirname, '');
const backendPort = env.PORT || '3000';

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
        aula: resolve(__dirname, 'src/client/aula.html'),
        radar: resolve(__dirname, 'src/client/radar.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${backendPort}`,
      '/socket.io': {
        target: `ws://localhost:${backendPort}`,
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
