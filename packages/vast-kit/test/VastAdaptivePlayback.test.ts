import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeHarnesses, harness, inLine, mediaUrl, TAG } from './harness.js'

const dash = vi.hoisted(() => ({
  manifest: null as string | null,
  fail: false,
  destroy: vi.fn(),
}))
vi.mock('dashjs', () => {
  const MediaPlayer = Object.assign(() => ({
    create() {
      const handlers = new Map<string, () => void>()
      return {
        on: (event: string, handler: () => void) => handlers.set(event, handler),
        off: (event: string) => handlers.delete(event),
        initialize(video: HTMLVideoElement, manifest: string) {
          dash.manifest = manifest
          if (dash.fail) {
            handlers.get('error')?.()
            return
          }
          video.src = 'blob:https://player.test/dash'
          video.load()
          handlers.get('ready')?.()
        },
        destroy: dash.destroy,
      }
    },
  }), { events: { STREAM_INITIALIZED: 'ready', ERROR: 'error' } })
  return { MediaPlayer }
})

const HLS = 'https://cdn.test/master.m3u8'
const DASH = 'https://cdn.test/master.mpd'
const MP4 = mediaUrl('adaptive')
const XML = inLine('adaptive').replace('</MediaFiles>',
  `<MediaFile delivery="streaming" type="application/vnd.apple.mpegurl" width="1280" height="720">${HLS}</MediaFile>
   <MediaFile delivery="streaming" type="application/dash+xml" width="1280" height="720">${DASH}</MediaFile></MediaFiles>`)

afterEach(() => {
  disposeHarnesses()
  dash.manifest = null
  dash.fail = false
  dash.destroy.mockClear()
})

describe('adaptive VAST playback', () => {
  it.each([
    ['Version/26.0 Safari/605.1.15', true, true, HLS],
    ['Chrome/149.0.0.0 Safari/537.36', true, true, 'blob:https://player.test/dash'],
    ['Firefox/151.0', false, true, 'blob:https://player.test/dash'],
    ['Firefox/151.0', false, false, MP4],
    ['Version/26.0 Safari/605.1.15', false, true, MP4],
  ])('chooses the playable format for %s', async (userAgent, nativeHls, supportsDash, source) => {
    const h = harness({
      documents: { [TAG]: XML },
      environment: { userAgent, supportsDash, canPlayType: (mime) => mime === 'video/mp4' || nativeHls },
    })
    void h.session.playBreak(TAG)
    await vi.waitFor(() => expect(h.ad.source).toBe(source))
    await h.settle()
    expect(h.snapshot.state.type).toBe('playing')
    if (source.startsWith('blob:')) {
      expect(dash.manifest).toBe(DASH)
      h.session.destroy()
      expect(dash.destroy).toHaveBeenCalledTimes(1)
    }
  })

  it('retries MP4 once when DASH fails before the first frame, tracking one ad', async () => {
    dash.fail = true
    const h = harness({
      documents: { [TAG]: XML },
      environment: { userAgent: 'Firefox/151.0', supportsDash: true, canPlayType: (mime) => mime === 'video/mp4' },
    })
    const done = h.session.playBreak(TAG)
    await vi.waitFor(() => expect(h.ad.source).toBe(MP4))
    await h.settle()
    await h.finishAd()
    await expect(done).resolves.toEqual({ outcome: { type: 'completed' }, adsStarted: 1 })
    expect(dash.manifest).toBe(DASH)
    expect(dash.destroy).toHaveBeenCalledTimes(1)
    expect(h.transport.urls.filter((url) => url.endsWith('/impression'))).toHaveLength(1)
    expect(h.transport.urls.some((url) => url.includes('/error?'))).toBe(false)
  })
})
