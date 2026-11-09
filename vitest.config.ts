import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const source = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

// Every package's tests from the root, in a DOM: `vast-core` parses with the
// platform's DOMParser exactly as it does in a browser, and the other packages
// drive real HTMLVideoElements (with the media pipeline faked) under jsdom.
// Packages import each other from source, as the typecheck does.
export default defineConfig({
  resolve: {
    alias: {
      '@kinodaran/vast-core': source('vast-core'),
      '@kinodaran/vast-kit': source('vast-kit'),
      '@kinodaran/vast-videojs': source('vast-videojs'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'jsdom',
  },
})
