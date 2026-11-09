import type { VastTick } from '@kinodaran/vast-core'
import type { VastClock } from './VastAdSessionTypes.js'

/**
 * Default {@link VastClock}: samples the ad's `<video>` element while one
 * creative plays.
 *
 * Also stamps `itemIsOurs`, which is how the tracking engine learns that the
 * element is no longer on this creative — the one situation where nothing after
 * this moment can be attributed to it.
 *
 * `rate` is the element's playback rate only while it is actually advancing:
 * paused, seeking, or starved of data (`readyState` below `HAVE_FUTURE_DATA`)
 * all read as 0, because quartiles only count at normal speed and a buffering
 * element's `paused` is still `false`.
 */
export class VastVideoClock implements VastClock {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly video: HTMLVideoElement,
    /** The source this clock's creative was loaded from. */
    private readonly source: string,
    /** Monotonic seconds, so a system clock change cannot be mistaken for progress. */
    private readonly now: () => number = () => performance.now() / 1000,
    /** 200 ms keeps quartile timing within a frame or two without waking the CPU on every frame. */
    private readonly intervalMillis = 200,
  ) {}

  start(onTick: (tick: VastTick) => void): void {
    this.stop()
    onTick(this.tick())
    this.timer = setInterval(() => onTick(this.tick()), this.intervalMillis)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): VastTick {
    const video = this.video
    const ours = isSameSource(video.currentSrc || video.src, this.source)
    const duration = video.duration
    const advancing = !video.paused && !video.seeking && video.readyState >= HAVE_FUTURE_DATA && !video.ended
    return {
      adTime: ours ? video.currentTime : 0,
      duration: ours && Number.isFinite(duration) && duration > 0 ? duration : null,
      rate: advancing ? video.playbackRate : 0,
      wallClock: this.now(),
      itemIsOurs: ours,
      isMuted: video.muted || video.volume === 0,
    }
  }
}

const HAVE_FUTURE_DATA = 3

/** `currentSrc` is absolute; the media file's URL may not be byte-identical once the element has resolved it. */
function isSameSource(current: string, expected: string): boolean {
  if (current === expected) return true
  try {
    return new URL(current).href === new URL(expected, current).href
  } catch {
    return false
  }
}
