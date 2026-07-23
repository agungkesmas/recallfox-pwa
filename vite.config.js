import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    chunkSizeWarningLimit: 1000
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'offline.html'],
      manifest: {
        name: 'RecallFox PWA',
        short_name: 'RecallFox',
        description: 'Cross-device media + notes + document scan sync untuk RecallFox',
        theme_color: '#6d3df5',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        scope: './',
        start_url: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          // v1.2.0 FIX BUG #2: HAPUS rule supabase-cache yang cache SEMUA request ke
          // Supabase (termasuk POST/PUT/DELETE ke /rest/v1/* dan /auth/v1/*).
          // Sebelumnya NetworkFirst untuk semua request Supabase → kalau network
          // timeout, SW kembalikan cache lama (data stale / response GET lama untuk
          // request POST baru). User lihat "tidak terjadi apa-apa" setelah upload.
          //
          // Sekarang: data endpoint selalu hit network. Offline read pakai IndexedDB
          // (sudah ada di db.js). Hanya gambar yang di-cache (CacheFirst).
          {
            // Hanya cache gambar screenshot dari Storage Supabase (public URLs).
            // Pattern ini hanya match URL yang mengandung /storage/v1/object/public/
            // dan berakhiran .png/.jpg/.jpeg/.webp — aman karena hanya GET.
            urlPattern: /^https:\/\/.*\.supabase\.co\/storage\/v1\/object\/public\/.*\.(?:png|jpg|jpeg|webp)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'supabase-image-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 }
            }
          },
          {
            // v1.4.0: Cache OpenCV.js dari jsdelivr CDN (8MB, lazy load saat mode Dokumen)
            // CacheFirst supaya setelah first load, next time cached (no re-download)
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/opencv\.js/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opencv-cache',
              expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 365 } // 1 year
            }
          },
          {
            // Cache gambar dari domain lain (jarang dipakai di PWA ini, tapi jaga-jaga)
            urlPattern: /\.(?:png|jpg|jpeg|svg|webp)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 }
            }
          }
        ]
      }
    })
  ]
});
