import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    open: false,
    watch: {
      ignored: ['**/public/data/**', '**/public/tiles/**']
    }
  },
  build: {
    target: 'esnext'
  }
});
