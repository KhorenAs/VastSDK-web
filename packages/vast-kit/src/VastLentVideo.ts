import type { VastBorrowedVideo } from './VastContentPlayer.js'
import { isInPictureInPicture } from './VastPictureInPicture.js'

/**
 * Whether a mid-roll plays in the content's own element while the content is
 * in a PiP window.
 *
 * - `'webkit'` — the default: in Safari and every other WebKit browser, where a
 *   PiP window cannot move from one element to another — it closes, animates
 *   back into the page, and a new one opens — so the only way for the ad to
 *   appear in the window at once, and the film to come back to it, is for both
 *   to play in the element the window belongs to. Elsewhere the ad takes the
 *   window over from its own element, which Chrome does in place.
 * - `true` — wherever the content's element can be lent.
 * - `false` — never.
 */
export type VastSameElementPiP = boolean | 'webkit'

export interface VastSameElementOptions {
  readonly sameElementPiP?: VastSameElementPiP
  /**
   * Lend an element that plays DRM-protected content too. The licence is
   * requested again when the film is put back, through whatever answered the
   * first request (videojs-contrib-eme, the host's own `encrypted` handler).
   * Off by default: check it against your licence server first.
   */
  readonly sameElementPiPForProtectedContent?: boolean
}

/** How long the film has to load again after the break before the session goes on without it. */
const RESTORE_TIMEOUT_MS = 8000
const RESTORE_POLL_MS = 50
/** The playhead may land this close to where the film stopped without another seek. */
const SEEK_TOLERANCE_SECONDS = 0.25

interface WebKitVideo {
  webkitSetPresentationMode?: (mode: string) => void
  webkitKeys?: unknown
}

/**
 * Sets a media element's source without the page noticing a change of source.
 *
 * Video.js wraps the element's own `src` setter, and a source set through it
 * becomes the player's: `currentSource()` would name the ad, and lose what the
 * host had passed with the film — `keySystems` among it, which the DRM plugin
 * needs to request a licence for the film once it is back. The prototype's
 * setter is the element's own, under any wrapper.
 */
export function setSourceQuietly(video: HTMLVideoElement, url: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')?.set
  if (setter) setter.call(video, url)
  else video.src = url
}

/**
 * Lends the content's element to a break, when the content is in a PiP window
 * and the element plays its film from a URL it can be given back: a
 * progressive file, or Safari's native HLS. Not a `MediaSource` (`blob:` or
 * `srcObject`) — there is no getting that back without the player that built
 * it — and not DRM-protected content unless the host opted in.
 *
 * `restore()` puts the film back where it was — source, position, loop,
 * volume and speed — and leaves starting it to `resumeAfterBreak`. The film is
 * loaded again, so it buffers for a moment.
 */
export function lendVideoForPictureInPicture(
  video: HTMLVideoElement | null | undefined,
  time: number,
  options: VastSameElementOptions = {},
): VastBorrowedVideo | null {
  if (!video || !isInPictureInPicture(video)) return null
  const mode = options.sameElementPiP ?? 'webkit'
  if (mode === false) return null
  const webkit = video as HTMLVideoElement & WebKitVideo
  if (mode === 'webkit' && typeof webkit.webkitSetPresentationMode !== 'function') return null
  if (video.srcObject) return null
  const protectedContent = Boolean(video.mediaKeys || webkit.webkitKeys)
  if (protectedContent && !options.sameElementPiPForProtectedContent) return null
  const source = video.currentSrc
  if (!/^https?:/i.test(source)) return null

  const settings = {
    loop: video.loop,
    autoplay: video.autoplay,
    defaultPlaybackRate: video.defaultPlaybackRate,
    playbackRate: video.playbackRate,
    volume: video.volume,
    muted: video.muted,
  }
  video.loop = false
  video.autoplay = false
  return {
    video,
    async restore() {
      try {
        if (!video.isConnected) return
        if (video.currentSrc !== source) setSourceQuietly(video, source)
        await metadataOf(video, source)
        if (Math.abs(video.currentTime - time) > SEEK_TOLERANCE_SECONDS) video.currentTime = time
      } finally {
        Object.assign(video, settings)
      }
    },
  }
}

/**
 * Settles once the element knows the film's duration again. Polled rather
 * than heard: while the element is lent its media events are kept from
 * everyone, so the host's player never sees the film being loaded again.
 */
function metadataOf(video: HTMLVideoElement, source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = Math.ceil(RESTORE_TIMEOUT_MS / RESTORE_POLL_MS)
    const check = (): void => {
      if (video.error) {
        reject(new Error(`the film did not load again (MediaError ${video.error.code})`))
      } else if (video.currentSrc === source && video.readyState >= 1) {
        resolve()
      } else if (--attempts <= 0) {
        reject(new Error('the film did not load again in time'))
      } else {
        setTimeout(check, RESTORE_POLL_MS)
      }
    }
    check()
  })
}
