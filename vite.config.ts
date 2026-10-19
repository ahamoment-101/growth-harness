import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { checkLocalConfiguration } from './scripts/configuration';

export default defineConfig(() => {
  checkLocalConfiguration();
  return {
    plugins: [react(), cloudflare()],
    build: { license: true },
  };
});
