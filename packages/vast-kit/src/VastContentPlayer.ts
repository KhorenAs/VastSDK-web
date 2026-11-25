import { lendVideoForPictureInPicture, type VastSameElementOptions } from './VastLentVideo.js'
import { isInPictureInPicture } from './VastPictureInPicture.js'

/**
 * The host's player, as the break needs it: something to stop before the ad
 * and to start again after it.
 *
 * The session normally plays the ad over the content in its own element, so
 * pausing a DRM-protected or adaptive stream preserves its keys and buffer.
 * While the content is in a PiP window, an adapter can lend its element
 * instead, so the ad appears in that window and the film comes back to it.
 */
export interface VastContentPlayer {
  /** The content element for handing off an already open Picture-in-Picture window. */
  readonly videoElement?: HTMLVideoElement | null

  /**
   * Lend the content's element for a mid-roll while the content is in a PiP
   * window, or `null` to have the ad take the window over from its own
   * element. See {@link lendVideoForPictureInPicture}.
   */
  borrowVideoForPiP?(): VastBorrowedVideo | null

  /**
   * The break is starting: pause, and take away whatever would let the viewer
   * reach the content's timeline — controls, hotkeys, a big play button.
   */
  pauseForBreak(): void

  /** The break is over: give the controls back and play from where the viewer was. */
  resumeAfterBreak(): void

  /** The content's volume, 0–1, so the ad starts as loud as what it interrupted. */
  readonly volume?: number

  /** Whether the content is muted, so an ad never starts louder than the viewer chose. */
  readonly muted?: boolean

  /** Seconds into the content, for `[CONTENTPLAYHEAD]`. */
  readonly currentTime?: number
}

export interface VastBorrowedVideo {
  readonly video: HTMLVideoElement
  /** Restore the content source and position, leaving playback to resumeAfterBreak. */
  restore(): Promise<void>
  /**
   * Stop the lending player hearing the element's media events — the ad's,
   * and the film's while it is put back — until the returned function is
   * called. Only the player: the browser's own controls listen to the same
   * element (Safari's PiP window keeps its timeline from these events), so
   * the events themselves must still reach everyone else.
   */
  hush?(): () => void
}

/**
 * The content player for a plain `<video>` element: pauses it, hides its native
 * controls for the break, and puts both back.
 *
 * Every value is saved before it is changed and restored from what was saved,
 * not from a default: a host that had hidden the controls itself gets them back
 * hidden.
 */
export function htmlVideoContent(video: HTMLVideoElement, options: VastSameElementOptions = {}): VastContentPlayer {
  let saved: { controls: boolean; wasPlaying: boolean; time: number } | null = null
  let lent = false
  return {
    videoElement: video,
    borrowVideoForPiP() {
      if (lent) return null
      const borrowed = lendVideoForPictureInPicture(video, saved?.time ?? video.currentTime, options)
      if (!borrowed) return null
      lent = true
      return {
        video: borrowed.video,
        async restore() {
          try {
            await borrowed.restore()
          } finally {
            lent = false
          }
        },
      }
    },
    pauseForBreak() {
      if (saved) return
      saved = { controls: video.controls, wasPlaying: !video.paused || video.autoplay, time: video.currentTime }
      exitNativeFullscreen(video)
      video.controls = false
      video.pause()
    },
    resumeAfterBreak() {
      if (!saved) return
      const { controls, wasPlaying, time } = saved
      saved = null
      video.controls = controls
      // Seeking the hidden content during the break is not the viewer's to keep.
      if (Math.abs(video.currentTime - time) > 0.5 && !video.ended) video.currentTime = time
      if (wasPlaying && !video.ended) void video.play().catch(() => undefined)
    },
    get volume() {
      return video.volume
    },
    get muted() {
      return video.muted
    },
    get currentTime() {
      return video.currentTime
    },
  }
}

interface WebKitVideo {
  webkitDisplayingFullscreen?: boolean
  webkitExitFullscreen?: () => void
}

/**
 * iPhone Safari plays `<video>` fullscreen in a system layer the page cannot
 * draw over — the one place an ad in an element of its own could not be seen.
 * Leaving it before the break is what IMA does on iOS too; the alternative is
 * an ad playing, and reporting quartiles, behind the viewer's back.
 */
export function exitNativeFullscreen(video: HTMLVideoElement): void {
  const webkit = video as HTMLVideoElement & WebKitVideo
  // WebKit also reports native Picture-in-Picture as displaying fullscreen.
  if (isInPictureInPicture(video)) return
  if (webkit.webkitDisplayingFullscreen && typeof webkit.webkitExitFullscreen === 'function') {
    try {
      webkit.webkitExitFullscreen()
    } catch {
      // Nothing to do: the break goes ahead inline.
    }
  }
}
