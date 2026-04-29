import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      // Raw PCM WebSocket — proxied as WS, not HTTP
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        // React dashboard — served at /
        main: resolve(__dirname, 'index.html'),
        // Fullscreen WebGL orb — served at /orb.html
        orb:  resolve(__dirname, 'orb.html'),
      },
    },
  },
})
