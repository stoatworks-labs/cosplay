import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/** Stamp the built version onto the support-footer tag, so feedback names the build (from arraycad). */
function supportFooterVersion(): Plugin {
  const tag = /<script\s[^>]*\bsrc="[^"]*support-footer\.js"/
  return {
    name: 'stoatworks-support-footer-version',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        if (!tag.test(html)) throw new Error('no support-footer.js tag in index.html — nothing to stamp')
        return html.replace(tag, (m) => `${m} data-version="v${pkg.version}"`)
      },
    },
  }
}

// Static SPA, no backend. The .dbpr never leaves the browser.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react(), supportFooterVersion()],
  base: './',
  assetsInclude: ['**/*.wasm'],
  server: { port: process.env.PORT ? Number(process.env.PORT) : undefined },
  build: { outDir: 'dist', sourcemap: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 60000 },
})
