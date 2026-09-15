import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'

const backend = process.env.VITE_FLITTERBOT_BASE_URL || 'http://127.0.0.1:18820'
const proxy = Object.fromEntries(
  ['/api', '/status', '/message', '/sessions/', '/hook/', '/runtime/whatsapp/', '/cron/', '/stop', '/ws'].map((prefix) => [prefix, { target: backend, ws: prefix === '/ws' }]),
)

export default defineConfig({
  preview: { host: '0.0.0.0', port: 8000, strictPort: true, proxy },
  server: {
    host: '0.0.0.0',
    port: 3188,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      router: {
        routeTreeFileHeader: [
          '// codedecorum: ignore all',
          '/* eslint-disable */',
          '// @ts-nocheck',
          '// noinspection JSUnusedGlobalSymbols',
        ],
      },
    }),
    viteReact(),
  ],
})
