import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VastAd } from '../src/VastAd.js'
import type { VastBeacon } from '../src/VastBeacon.js'
import type { VastDocumentEntry, VastWrapper } from '../src/VastDocument.js'
import { VastParser } from '../src/VastParser.js'

/**
 * Fixtures come from the IAB sample tags shipped with dailymotion/vast-client-js
 * (MIT), plus two live responses, and are the same files VastSDK-apple and
 * VastSDK-android test against. They are used because they carry the
 * inconsistencies real ad servers produce, which synthetic XML never does.
 */
export function fixture(name: string): string {
  // Not `new URL('./fixtures/…', import.meta.url)`: Vite rewrites that pattern
  // into a dev-server asset URL under the jsdom environment, which fs cannot read.
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', `${name}.xml`), 'utf8')
}

export function inLine(entry: VastDocumentEntry | undefined): VastAd {
  if (entry?.body.type !== 'inLine') throw new Error(`expected an InLine entry, got ${JSON.stringify(entry?.body)}`)
  return entry.body.ad
}

export function wrapper(entry: VastDocumentEntry | undefined): VastWrapper {
  if (entry?.body.type !== 'wrapper') throw new Error(`expected a Wrapper entry, got ${JSON.stringify(entry?.body)}`)
  return entry.body.wrapper
}

export function firstAd(xml: string): VastAd {
  return inLine(new VastParser().parse(xml).entries[0])
}

/** Foundation's `URL.lastPathComponent`, for assertions written the same way as the Apple tests. */
export function lastPathComponent(url: string): string {
  const path = url.split('#')[0]!.split('?')[0]!.replace(/\/+$/, '')
  return path.substring(path.lastIndexOf('/') + 1)
}

/** Foundation's `URL.query`. */
export function query(url: string): string | null {
  const beforeFragment = url.split('#')[0]!
  const at = beforeFragment.indexOf('?')
  if (at < 0) return null
  const q = beforeFragment.substring(at + 1)
  return q.length > 0 ? q : null
}

/** Short, stable name for assertions. */
export function label(beacon: VastBeacon): string {
  const kind = beacon.kind
  switch (kind.type) {
    case 'impression':
      return 'impression'
    case 'tracking':
      return kind.event
    case 'progress':
      return lastPathComponent(beacon.url)
    case 'clickTracking':
      return 'clickTracking'
    case 'error':
      return `error ${kind.error}`
    case 'verificationNotExecuted':
      return `verificationNotExecuted ${kind.reason}`
    case 'viewUndetermined':
      return 'viewUndetermined'
    case 'customClick':
      return 'customClick'
  }
}
