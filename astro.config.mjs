import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import AstroPWA from '@vite-pwa/astro';
import vercel from '@astrojs/vercel';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  site: 'https://example.com',
  security: {
    // Custom CSRF middleware already protects mutating requests.
    // Disable Astro origin check to avoid false 403 behind Vercel edge/proxy.
    checkOrigin: false,
  },

  // ✅ Server Rendered
  output: 'server',
  adapter: vercel(),

  server: {
    host: true,
    port: 4321,
    https: true
  },

  integrations: [
    react(),
    mdx(),
    sitemap(),
    ...(
      String(process.env.ENABLE_PWA || '').trim().toLowerCase() === 'true'
        ? [AstroPWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'GO',
        short_name: 'GO',
        description: 'UI GO',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 45000000,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}']
      }
    })]
        : []
    )
  ],

  vite: {
    plugins: [
      process.env.NODE_ENV === 'development' && basicSsl()
    ].filter(Boolean),

    server: {
      host: true,
      allowedHosts: 'all',
      strictPort: true,
      https: true
    },

    define: {
      CESIUM_BASE_URL: JSON.stringify('/cesium')
    }
  }
});