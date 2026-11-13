import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/requests': 'http://127.0.0.1:5000',
      '/assets': 'http://127.0.0.1:5000',
      '/whoami': 'http://127.0.0.1:5000',
    },
  },
});
