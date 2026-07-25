import { defineConfig } from 'vite';

// itch.io serves the uploaded zip from a nested, non-root path, so every asset
// reference has to be relative. `base: './'` is the single most important
// setting in this file — without it the game 404s on itch and works locally,
// which is the classic jam-day heart attack.
export default defineConfig({
  base: './',
  build: {
    target: ['es2020', 'chrome80', 'safari14'],
    assetsInlineLimit: 8192,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
    // 600kB of three.js in one file beats four requests on itch's CDN — the
    // game is downloaded once and played in an iframe, so caching buys nothing.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'assets/pogo-drop.[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
