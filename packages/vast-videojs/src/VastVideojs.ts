import {
  VastAdOverlay,
  VastAdSession,
  exitNativeFullscreen,
  type VastAdOverlayOptions,
  type VastConfiguration,
  type VastContentPlayer,
} from '@kinodaran/vast-kit'

/**
 * The part of a Video.js player this adapter uses — every method has been on
 * the player since Video.js 5, so 7 and 8 both satisfy it, and the package
 * imports nothing from `video.js` itself: the host's own copy, whatever its
 * version, is the only one in the bundle.
 */
export interface VideoJsPlayerLike {
  el(): Element
  pause(): unknown
  play(): Promise<void> | undefined | void
  paused(): boolean
  ended(): boolean
  currentTime(): number
  currentTime(seconds: number): unknown
  volume(): number
  muted(): boolean
  controls(): boolean
  controls(enabled: boolean): unknown
  addClass(className: string): unknown
  removeClass(className: string): unknown
  on(event: string, handler: (...args: unknown[]) => void): unknown
  off(event: string, handler: (...args: unknown[]) => void): unknown
  autoplay?(): unknown
}

/** The class the player carries while a break is on screen, for a host's own CSS. */
export const VAST_BREAK_CLASS = 'vast-ad-playing'

/**
 * The content player for Video.js: pauses the film, takes the controls away
 * for the break, and gives everything back where the viewer left it.
 *
 * The film is only ever paused — never unloaded — so VHS keeps its buffer and
 * EME keeps its keys, and the content resumes from the frame it stopped on
 * without a new licence request. That is the whole reason the ad plays in an
 * element of its own.
 *
 * - The control bar goes (`controls(false)`): an ad the viewer can scrub is an
 *   ad the viewer can get past, and the content's timeline is under the ad.
 * - A `play` on the content during the break — a hotkey, the host's own code
 *   reacting to something — is undone at once. The content does not play
 *   behind an ad.
 * - Every value is saved before it is changed and restored from what was
 *   saved, not from a default: a host that had hidden the controls itself gets
 *   them back hidden.
 */
export function videojsContent(player: VideoJsPlayerLike): VastContentPlayer {
  let saved: { controls: boolean; wasPlaying: boolean; time: number } | null = null
  const holdContent = (): void => {
    if (saved) player.pause()
  }

  return {
    pauseForBreak() {
      if (saved) return
      const video = player.el().querySelector('video')
      if (video) exitNativeFullscreen(video)
      saved = {
        controls: player.controls(),
        // A pre-roll asked for on the first `play` arrives before the film has
        // really started: "about to play" is still "playing" for what comes after.
        wasPlaying: !player.paused() || Boolean(player.autoplay?.()),
        time: player.currentTime(),
      }
      player.addClass(VAST_BREAK_CLASS)
      player.controls(false)
      player.pause()
      player.on('play', holdContent)
    },

    resumeAfterBreak() {
      if (!saved) return
      const { controls, wasPlaying, time } = saved
      saved = null
      player.off('play', holdContent)
      player.removeClass(VAST_BREAK_CLASS)
      player.controls(controls)
      // A seek on the hidden content during the break is not the viewer's to keep.
      if (!player.ended() && Math.abs(player.currentTime() - time) > 0.5) player.currentTime(time)
      if (wasPlaying && !player.ended()) {
        const result = player.play()
        if (result && typeof (result as Promise<void>).catch === 'function') (result as Promise<void>).catch(() => undefined)
      }
    },

    get volume() {
      return player.volume()
    },
    get muted() {
      return player.muted()
    },
    get currentTime() {
      return player.currentTime()
    },
  }
}

export interface VastVideojsOptions {
  readonly configuration?: Partial<VastConfiguration>
  /** `false` for a host drawing its own ad UI (then set `skipPresentation: 'host'`). Default: the SDK's overlay. */
  readonly overlay?: boolean | VastAdOverlayOptions
}

export interface VastVideojs {
  readonly session: VastAdSession
  readonly overlay: VastAdOverlay | null
  /** Tears down the session and the overlay. Called for you when the player is disposed. */
  destroy(): void
}

/**
 * A VAST session wired to a Video.js player — the replacement for
 * `player.ima(...)`:
 *
 * ```ts
 * const vast = createVastVideojs(player)
 * player.one('play', () => vast.session.playBreak(prerollUrl, { position: 'preroll' }))
 * ```
 *
 * The break is drawn over `player.el()`, so it follows the player into its
 * fullscreen. Every tap, click or key on the player calls `session.prepare()`,
 * which is what lets iOS Safari start the ad with sound — the job IMA gives
 * `initializeAdDisplayContainer()`, without the host having to remember it.
 */
export function createVastVideojs(player: VideoJsPlayerLike, options: VastVideojsOptions = {}): VastVideojs {
  const container = player.el() as HTMLElement
  const session = new VastAdSession({
    container,
    content: videojsContent(player),
    configuration: options.configuration,
  })
  const overlay =
    options.overlay === false
      ? null
      : new VastAdOverlay(session, typeof options.overlay === 'object' ? options.overlay : {})

  const prepare = (): void => session.prepare()
  const gestures = ['click', 'touchend', 'keydown'] as const
  for (const gesture of gestures) container.addEventListener(gesture, prepare, { capture: true, passive: true })

  let destroyed = false
  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    for (const gesture of gestures) container.removeEventListener(gesture, prepare, { capture: true })
    player.off('dispose', destroy)
    overlay?.destroy()
    session.destroy()
  }
  player.on('dispose', destroy)

  return { session, overlay, destroy }
}

/** The `videojs` function's plugin registry, as much of it as this needs. */
export interface VideoJsLike {
  registerPlugin(name: string, plugin: (this: VideoJsPlayerLike, options?: VastVideojsOptions) => VastVideojs): unknown
}

/**
 * Registers `player.vast(options)` — the same thing as {@link createVastVideojs},
 * for hosts used to Video.js plugins:
 *
 * ```ts
 * registerVastPlugin(videojs)
 * const vast = player.vast({ configuration: { macroValues: { contentId } } })
 * ```
 */
export function registerVastPlugin(videojs: VideoJsLike, name = 'vast'): void {
  videojs.registerPlugin(name, function (this: VideoJsPlayerLike, options?: VastVideojsOptions) {
    return createVastVideojs(this, options)
  })
}
