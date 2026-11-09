import type {
  VastAd,
  VastBeaconKind,
  VastError,
  VastMacroValues,
  VastResourceLoader,
  VastTick,
} from '@kinodaran/vast-core'
import type { VastBeaconTransport } from './VastBeaconTransport.js'

/** Where a session is, as the host's UI reads it. */
export type VastAdState =
  | { readonly type: 'idle' }
  /** Resolving the response, or waiting for a creative to start. */
  | { readonly type: 'loading' }
  | { readonly type: 'playing' }
  | { readonly type: 'paused' }
  | { readonly type: 'finished'; readonly outcome: VastAdOutcome }

export type VastAdOutcome =
  | { readonly type: 'completed' }
  | { readonly type: 'skipped' }
  | { readonly type: 'failed'; readonly error: VastError }

/** `loading` counts as inside: the break takes the controls a moment early, which is the safe direction. */
export function isOutsideBreak(state: VastAdState): boolean {
  return state.type === 'idle' || state.type === 'finished'
}

/** Position within the pod, 1-based. `{ index: 1, total: 1 }` for a single ad. */
export interface VastAdPosition {
  readonly index: number
  readonly total: number
}

export const SINGLE_AD_POSITION: VastAdPosition = { index: 1, total: 1 }

export function isPod(position: VastAdPosition): boolean {
  return position.total > 1
}

/**
 * Who provides the skip control.
 *
 * Not a styling choice. VAST 4.3 §2.3 states the player should not "play the
 * Skippable Ad as a Linear Ad (without skip controls)", so this decides whether a
 * skippable ad may be played at all — an advertiser paid the skippable rate and
 * is owed the skip.
 *
 * - `sdk` — the SDK's overlay draws the control. Compliant by construction.
 * - `host` — the host draws it, reading `canSkip` and `timeUntilSkip`, and calls `skip()`.
 * - `unsupported` — skippable ads are refused with VAST error 200 rather than
 *   played without a skip control.
 */
export type VastSkipPresentation = 'sdk' | 'host' | 'unsupported'

/**
 * How a click reaches the advertiser.
 *
 * §3.10.1 makes `ClickThrough` support Required, and describes it as the URI
 * "the media player opens when a viewer clicks the ad" — the ad surface itself,
 * not necessarily a separate button.
 *
 * - `surface` — clicking the ad opens the destination. The spec's own model.
 * - `host` — the host wires its own affordance and calls `click()`.
 * - `disabled` — no click path at all. Not compliant; opt in knowingly.
 */
export type VastClickPresentation = 'surface' | 'host' | 'disabled'

/**
 * What the browser's media controls — the Media Session API behind media keys,
 * a headset, the lock screen and the OS media hub — show and allow during a break.
 *
 * - `describesAd` — they name the ad, and the actions that would get a viewer
 *   past it (seek, next track) are switched off for its length.
 * - `untouched` — the session leaves `navigator.mediaSession` alone; a host that
 *   manages it itself takes over that responsibility.
 */
export type VastMediaSessionPolicy = 'describesAd' | 'untouched'

/** Where a break sits in the content, for `[BREAKPOSITION]` and for what waits on it. */
export type VastBreakPosition = 'preroll' | 'midroll' | 'postroll'

/**
 * The tag a break is asked to play: the ad server's URL, or a response already
 * in hand. `baseUrl` resolves a relative `<VASTAdTagURI>` inside that response.
 */
export type VastAdTag = string | { readonly url: string } | { readonly xml: string; readonly baseUrl?: string | null }

/** Why `skip()` refused. It never refuses silently: an unhonoured skip violates §2.3. */
export class VastSkipError extends Error {
  override readonly name = 'VastSkipError'

  private constructor(
    readonly reason: 'noActiveAd' | 'notSkippable' | 'notYetAvailable',
    message: string,
    /** For `notYetAvailable`: seconds until the control unlocks. */
    readonly afterSeconds: number | null = null,
  ) {
    super(message)
  }

  static noActiveAd(): VastSkipError {
    return new VastSkipError('noActiveAd', 'no ad is playing')
  }

  static notSkippable(): VastSkipError {
    return new VastSkipError('notSkippable', 'the ad on screen declares no skipoffset')
  }

  static notYetAvailable(afterSeconds: number): VastSkipError {
    return new VastSkipError('notYetAvailable', `skip unlocks in ${afterSeconds} s`, afterSeconds)
  }
}

/**
 * Source of playhead observations for the tracking engine.
 *
 * An interface for two reasons: tests drive a scripted tick sequence with no
 * player at all, and a host that already runs its own playback-time accounting
 * can feed that in directly. An injected clock is reused for every ad in a pod,
 * so `start` must work again after `stop`. The built-in clock is instead built
 * per ad, because it binds to that ad's video element and source.
 */
export interface VastClock {
  start(onTick: (tick: VastTick) => void): void
  stop(): void
}

/**
 * Everything a host may tune or swap out. Supplying fakes lets the whole
 * session run against a scripted clock, transport and loader.
 *
 * The defaults are the compliant ones: the SDK draws the skip control and the
 * ad surface is clickable, so a host that configures nothing still honours §2.3
 * and §3.10.1.
 */
export interface VastConfiguration {
  /** VAST 4.3 §3.19.1 requires accepting at least five. */
  readonly maxWrapperDepth: number
  readonly wrapperTimeoutSeconds: number
  /**
   * Total time a response may take to resolve, however many Wrappers it needs.
   * `wrapperTimeoutSeconds` bounds one hop, and five hops at five seconds is
   * twenty-five — a viewer who waited that long for an ad was shown a bug, not
   * an ad. While it runs a pre-roll's content waits. Zero disables the budget.
   */
  readonly resolutionTimeoutSeconds: number
  /**
   * How long a creative may take from being handed to the video element to
   * showing its first frame before it is written off (402). The web has no
   * Media3 load-error timeout to lean on, so the session keeps its own.
   */
  readonly mediaLoadTimeoutSeconds: number
  readonly skipPresentation: VastSkipPresentation
  readonly clickPresentation: VastClickPresentation
  readonly mediaSession: VastMediaSessionPolicy
  /**
   * Whether the host is willing to draw the whole ad UI itself when a response
   * asks it to.
   *
   * `false`, the default, means the SDK draws its own UI whatever the response
   * says. That is deliberate: `<Extensions>` is vendor territory, and a vendor
   * key must not be able to take the §2.3 skip promise away from a host that
   * never agreed to honour it. Set it to `true` and a response carrying the
   * `uiSettings` UI-hidden key gets no SDK UI at all — skip included — for that
   * creative; the host must then provide its controls.
   */
  readonly allowsHiddenUi: boolean
  /**
   * Whether VAST requests carry the viewer's cookies (`fetch` `credentials`).
   *
   * VAST asks ad servers to answer credentialed CORS requests, and targeting
   * often depends on them, so `include` is the default. An ad server that
   * answers `Access-Control-Allow-Origin: *` cannot be read with credentials at
   * all; the loader then retries the same hop once without them rather than
   * failing the break.
   */
  readonly requestCredentials: RequestCredentials
  /** `null` uses the built-in clock, which samples the ad's video element every 200 ms. */
  readonly clock: VastClock | null
  /** `null` uses `VastFetchTransport` with the shared retry queue. */
  readonly transport: VastBeaconTransport | null
  /** `null` uses `VastFetchLoader`. */
  readonly loader: VastResourceLoader | null
  /**
   * §6 macro values only the host can supply — identifier, consent, where this
   * break sits in its content. Unsupplied values report `-1`, which is honest
   * and also often unbiddable; see `VastMacroValues`.
   */
  readonly macroValues: VastMacroValues
}

export const DEFAULT_CONFIGURATION: VastConfiguration = {
  maxWrapperDepth: 5,
  wrapperTimeoutSeconds: 5,
  resolutionTimeoutSeconds: 10,
  mediaLoadTimeoutSeconds: 8,
  skipPresentation: 'sdk',
  clickPresentation: 'surface',
  mediaSession: 'describesAd',
  allowsHiddenUi: false,
  requestCredentials: 'include',
  clock: null,
  transport: null,
  loader: null,
  macroValues: {},
}

/**
 * Everything the session publishes, as one immutable value.
 *
 * A new object on every change and the same object otherwise, so it plugs
 * straight into React's `useSyncExternalStore(session.subscribe,
 * session.getSnapshot)` — or any store that compares by identity.
 */
export interface VastAdSnapshot {
  readonly state: VastAdState
  readonly currentAd: VastAd | null
  readonly adPosition: VastAdPosition
  /** Seconds left in the creative on screen. */
  readonly remainingTime: number
  /** `true` once `skipoffset` has elapsed on a skippable ad. */
  readonly canSkip: boolean
  /** Seconds until the skip control unlocks; `null` when the ad is not skippable or already is. */
  readonly timeUntilSkip: number | null
  /** Whether the ad's sound is off — chosen by the viewer, or imposed by the browser's autoplay policy. */
  readonly isMuted: boolean
  /**
   * `true` when the browser refused to start the ad with sound and the session
   * started it muted instead. The overlay offers an unmute control; a host
   * drawing its own UI should too.
   */
  readonly mutedByAutoplayPolicy: boolean
  /** Breaks asked for while another was on screen, waiting their turn. */
  readonly pendingBreakCount: number
  /**
   * Whether the host's own transport controls should be offered right now.
   *
   * `false` for the length of a break, because an ad the viewer can scrub is an
   * ad the viewer can get past: VAST defines no attribute that would permit
   * seeking inside a linear creative. Also `false` in the gap between breaks
   * asked for together, while the content waits for the next one.
   */
  readonly permitsPlaybackControls: boolean
  /** Whether the ad on screen must be drawn by the host: the host allowed it *and* this response asked for it. */
  readonly suppressesAdUi: boolean
  /** Hidden UI hands the current creative's controls to the host. Otherwise the configured policy stands. */
  readonly effectiveSkipPresentation: VastSkipPresentation
}

/**
 * What the session did, for a host that wants to know without reading
 * snapshots. Subscribe with `session.on(name, handler)`; every event is optional.
 */
export interface VastAdSessionEvents {
  adStarted: (ad: VastAd, position: VastAdPosition) => void
  /**
   * Playback position, once per tick. `duration` is what the player reports,
   * falling back to `<Duration>` until it does — the declared value is advisory
   * and the two often disagree.
   */
  adProgress: (ad: VastAd, timeSeconds: number, durationSeconds: number) => void
  /** `skipoffset` elapsed — a host drawing its own control draws it now. */
  skipAvailable: (ad: VastAd) => void
  adFinished: (ad: VastAd, outcome: VastAdOutcome) => void
  /**
   * One ad failed, or the response produced none (`ad` is then `null`). A pod
   * continues with the next ad or a stand-alone substitute, and the content
   * plays whatever happens.
   */
  adFailed: (error: VastError, ad: VastAd | null) => void
  /** The break is over and the content is back (or, with breaks waiting, about to be their turn). */
  allAdsFinished: () => void
  /**
   * The SDK owns the skip control for this ad but cannot show it: no overlay is
   * mounted, it is too small, or the control itself drew at no usable size.
   */
  skipControlUnavailable: (ad: VastAd, reason: string) => void
  /** The ad declares a ClickThrough that no viewer can reach — on a TV left on `surface`, say. */
  clickThroughUnavailable: (ad: VastAd, reason: string) => void
  /**
   * The session reported something to the ad server.
   *
   * Called once per distinct kind, in the order the beacons went out, and whether
   * or not the network accepted them — what is reported is the event, not the
   * delivery. A response carrying three `<Impression>` URLs is three beacons and
   * one impression, so this fires once for it.
   *
   * Tracking is the one thing a host cannot observe for itself: the beacons live
   * inside the response and go out from here. This is a mirror, not a hook, and
   * nothing is asked of the listener.
   */
  reported: (kind: VastBeaconKind, ad: VastAd | null) => void
}

/** How a break ended, for the promise `playBreak` returns. */
export interface VastBreakResult {
  /** The last ad's outcome, or the reason no ad played. */
  readonly outcome: VastAdOutcome
  /** Ads that reached the screen. Zero when the response produced nothing playable. */
  readonly adsStarted: number
}
