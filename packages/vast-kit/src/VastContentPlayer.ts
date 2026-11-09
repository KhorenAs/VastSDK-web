/**
 * The host's player, as the break needs it: something to stop before the ad
 * and to start again after it.
 *
 * The ad never plays in the content's own element. Kinodaran's content is
 * DRM-protected HLS and DASH behind Video.js; swapping an ad into that element
 * would tear down the media keys and the adaptive stream and build them again
 * afterwards, which is exactly the fragile part of an IMA integration. The ad
 * plays in an element of the session's own over the content, and the content
 * only has to pause.
 */
export interface VastContentPlayer {
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

/**
 * The content player for a plain `<video>` element: pauses it, hides its native
 * controls for the break, and puts both back.
 *
 * Every value is saved before it is changed and restored from what was saved,
 * not from a default: a host that had hidden the controls itself gets them back
 * hidden.
 */
export function htmlVideoContent(video: HTMLVideoElement): VastContentPlayer {
  let saved: { controls: boolean; wasPlaying: boolean; time: number } | null = null
  return {
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
  if (webkit.webkitDisplayingFullscreen && typeof webkit.webkitExitFullscreen === 'function') {
    try {
      webkit.webkitExitFullscreen()
    } catch {
      // Nothing to do: the break goes ahead inline.
    }
  }
}
