import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  define: { __BUILD__: JSON.stringify(`v${pkg.version} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`) },
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 3000 },
  build: { outDir: 'dist', sourcemap: false },
})
