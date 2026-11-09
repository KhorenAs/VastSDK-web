import { VastError } from '@kinodaran/vast-core'
import { VastLog } from './VastLog.js'

/** What the ad element tells the session about the creative it was handed. */
export interface VastAdPlayerListener {
  /** Enough of the creative is buffered to render: what `loaded` means (§3.14.1). */
  loaded(): void
  /** The first frame is on screen and the playhead is moving. */
  started(): void
  /** The element started or stopped, by anyone. */
  playbackChanged(wantsPlayback: boolean): void
  /** The creative played to its end. */
  ended(): void
  failed(error: VastError): void
}

/**
 * How the creative got going.
 *
 * - `started` — playing, as loud as it was asked to be (muted too, if the content was).
 * - `mutedByPolicy` — the browser refused sound, so it plays muted and the
 *   viewer is offered an unmute control.
 * - `refused` — the browser refused playback even muted; the page has no
 *   gesture to its name and autoplay is off.
 * - `interrupted` — something else stopped it (a later load, an unplayable
 *   source); the element's `error` event, or the load timeout, says what.
 */
export type VastStartResult = 'started' | 'mutedByPolicy' | 'refused' | 'interrupted'

/**
 * The element a break plays in: one `<video>` inside one layer, laid over the
 * host's player and shown only while a break is on screen.
 *
 * It is created once per session and reused for every creative, because on
 * iOS Safari the right to start playback programmatically belongs to the
 * element a user gesture touched — a fresh element per ad would have to be
 * unlocked again, and there is no gesture to unlock it with in the middle of a
 * film. {@link prepare} is that unlock.
 *
 * The element is never given controls, Picture in Picture or remote playback:
 * every one of them is a way to scrub, background or cast an ad out from under
 * its tracking, and the session draws what the viewer is owed — skip, click,
 * unmute — itself.
 */
export class VastAdPlayer {
  /** Absolutely positioned over the host's player; the overlay mounts here, above the video. */
  readonly layer: HTMLDivElement
  readonly video: HTMLVideoElement

  private listener: VastAdPlayerListener | null = null
  private source: string | null = null
  private startedSource: string | null = null
  private loadedSource: string | null = null
  private readonly disposers: Array<() => void> = []

  constructor(readonly container: HTMLElement) {
    const doc = container.ownerDocument
    this.layer = doc.createElement('div')
    this.layer.className = 'vast-ad-layer'
    this.layer.setAttribute('data-vast-ad-layer', '')
    Object.assign(this.layer.style, {
      position: 'absolute',
      inset: '0',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      display: 'none',
      background: '#000',
      // Above anything a player skin draws over its own video, and within the
      // container's stacking context, so it follows the container into fullscreen.
      zIndex: '2147483000',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>)

    const video = doc.createElement('video')
    video.className = 'vast-ad-video'
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.setAttribute('x-webkit-airplay', 'deny')
    video.preload = 'auto'
    video.controls = false
    setFlag(video, 'disablePictureInPicture')
    setFlag(video, 'disableRemotePlayback')
    Object.assign(video.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      background: '#000',
    } satisfies Partial<CSSStyleDeclaration>)
    this.video = video
    this.layer.appendChild(video)

    if (doc.defaultView?.getComputedStyle(container).position === 'static') {
      // The layer is positioned against the container; a static container would
      // let it cover the whole page instead of the player.
      container.style.position = 'relative'
    }
    container.appendChild(this.layer)
    this.observe()
  }

  /**
   * Call from inside a user gesture — the play button's click handler — before
   * the first break. iOS Safari lets a page start a `<video>` programmatically
   * only once a gesture has touched that element; `load()` here is that touch,
   * and every later creative in this element inherits it. Elsewhere it is
   * harmless. The same job as IMA's `AdDisplayContainer.initialize()`.
   */
  prepare(): void {
    try {
      if (!this.source) this.video.load()
    } catch {
      // Unlocking is best effort; a refused start falls back to muted playback.
    }
  }

  /** Hands the element one creative and starts it. */
  async load(
    url: string,
    listener: VastAdPlayerListener,
    sound: { volume: number; muted: boolean },
  ): Promise<VastStartResult> {
    this.listener = listener
    this.source = url
    this.startedSource = null
    this.loadedSource = null
    this.video.muted = sound.muted
    this.video.volume = clamp(sound.volume)
    this.video.src = url
    this.video.load()
    return this.start()
  }

  /**
   * `play()`, falling back to muted when the browser's autoplay policy refuses
   * sound. A muted start is not a §3.14.1 `mute` — the viewer chose nothing —
   * so it is returned for the session to show, not reported.
   */
  private async start(): Promise<VastStartResult> {
    const source = this.source
    try {
      await this.video.play()
      return 'started'
    } catch (error) {
      if (source !== this.source) return 'interrupted'
      // Anything but a policy refusal — no playable source, an abort by a later
      // load — is reported through the element's `error` event, not from here.
      if (!isAutoplayRefusal(error)) return 'interrupted'
      if (this.video.muted) return 'refused'
    }
    try {
      this.video.muted = true
      await this.video.play()
      VastLog.notice('autoplay with sound refused; the ad started muted')
      return 'mutedByPolicy'
    } catch (error) {
      if (source !== this.source || !isAutoplayRefusal(error)) return 'interrupted'
      return 'refused'
    }
  }

  get wantsPlayback(): boolean {
    return this.source !== null && !this.video.paused
  }

  play(): void {
    if (!this.source) return
    void this.video.play().catch(() => undefined)
  }

  pause(): void {
    if (this.source) this.video.pause()
  }

  setMuted(muted: boolean): void {
    this.video.muted = muted
    if (!muted && this.video.volume === 0) this.video.volume = 1
  }

  show(): void {
    this.layer.style.display = 'block'
  }

  hide(): void {
    this.layer.style.display = 'none'
  }

  /** Lets go of the creative, so the element stops buffering it. */
  unload(): void {
    this.listener = null
    this.source = null
    this.startedSource = null
    this.loadedSource = null
    this.video.pause()
    this.video.removeAttribute('src')
    try {
      this.video.load()
    } catch {
      // Detached or already torn down.
    }
  }

  destroy(): void {
    this.unload()
    for (const dispose of this.disposers.splice(0)) dispose()
    this.layer.remove()
  }

  private observe(): void {
    const on = (name: string, handler: () => void): void => {
      this.video.addEventListener(name, handler)
      this.disposers.push(() => this.video.removeEventListener(name, handler))
    }
    const current = (): VastAdPlayerListener | null => (this.source ? this.listener : null)

    on('loadeddata', () => {
      if (!this.source || this.loadedSource === this.source) return
      this.loadedSource = this.source
      current()?.loaded()
    })
    on('playing', () => {
      if (!this.source) return
      if (this.startedSource !== this.source) {
        this.startedSource = this.source
        if (this.loadedSource !== this.source) {
          this.loadedSource = this.source
          current()?.loaded()
        }
        current()?.started()
      }
    })
    on('play', () => current()?.playbackChanged(true))
    on('pause', () => {
      // The element pauses itself on reaching the end; that is `ended`, not a pause.
      if (!this.video.ended) current()?.playbackChanged(false)
    })
    on('ended', () => current()?.ended())
    on('error', () => {
      const listener = current()
      if (!listener) return
      listener.failed(errorFor(this.video.error))
    })
  }
}

/**
 * The element's `MediaError`, as the VAST table names it.
 *
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` is what browsers raise for a 404 as much as for
 * an undecodable file. The session only hands the element files that
 * `canPlayType` already accepted, so by then it is far more likely the file is
 * not there — 401, as the Android SDK reports an HTTP failure — than a format
 * the browser has just said it plays.
 */
export function errorFor(error: MediaError | null): VastError {
  switch (error?.code) {
    case 2: // MEDIA_ERR_NETWORK
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return VastError.MEDIA_FILE_NOT_FOUND
    default: // MEDIA_ERR_DECODE, or an error with no code at all
      return VastError.MEDIA_FILE_DISPLAY_PROBLEM
  }
}

function isAutoplayRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NotAllowedError'
}

function setFlag(video: HTMLVideoElement, name: 'disablePictureInPicture' | 'disableRemotePlayback'): void {
  try {
    ;(video as unknown as Record<string, boolean>)[name] = true
  } catch {
    // Older engines: the attribute below is what they read, if anything.
  }
  video.setAttribute(name.toLowerCase(), '')
}

function clamp(volume: number): number {
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
}
