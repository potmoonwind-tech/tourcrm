import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Same-origin /api in dev, so the session cookie works without CORS.
  // The port the preview hands out (PORT), else Vite's usual 5173.
  server: { port: Number(process.env.PORT) || 5173, proxy: { '/api': 'http://localhost:8000' } },
})
