import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const source = (name: string) => fileURLToPath(new URL(`../packages/${name}/src/index.ts`, import.meta.url))

// The demo runs the SDK from source, so a change in any package shows up on
// reload without a build — the same mapping the tests and typecheck use.
export default defineConfig({
  resolve: {
    alias: {
      '@kinodaran/vast-core': source('vast-core'),
      '@kinodaran/vast-kit': source('vast-kit'),
      '@kinodaran/vast-videojs': source('vast-videojs'),
    },
  },
  build: { target: 'es2017' },
})
