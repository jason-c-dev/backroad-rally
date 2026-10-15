import { defineConfig } from 'vite';

// GitHub Pages serves the site at /backroad-rally/; dev serves it at /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/backroad-rally/' : '/',
}));
