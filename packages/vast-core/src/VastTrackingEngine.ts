import { skipOffsetSeconds } from './VastAd.js'
import type { VastAd } from './VastAd.js'
import type { VastBeacon, VastBeaconKind } from './VastBeacon.js'
import { VastError } from './VastError.js'
import type { VastTick } from './VastTick.js'
import { VastTrackingEvent } from './VastTrackingEvent.js'
import { omidResource, VastNotExecutedReason } from './VastVerification.js'

/** Where each quartile falls, as a fraction of the creative, in the order they fire. */
const QUARTILES: readonly (readonly [number, VastTrackingEvent])[] = [
  [0.25, 'firstQuartile'],
  [0.5, 'midpoint'],
  [0.75, 'thirdQuartile'],
]

/**
 * Decides which beacons a playback session owes, from a stream of ticks.
 *
 * Pure and deterministic: no IO, no player, no wall-clock reads of its own. Feed
 * it a tick sequence and it returns the beacons — which is exactly how the seek
 * and asset-swap rules are tested.
 *
 * Holds mutable state; a session drives one engine and nothing else touches it.
 */
export class VastTrackingEngine {
  /**
   * A jump larger than this, relative to what elapsed wall-clock allows, is
   * treated as a seek rather than playback.
   */
  static readonly SEEK_TOLERANCE: number = 0.75

  /**
   * Fraction of the creative that counts as "played to the end". Declared
   * `<Duration>` and real media length routinely differ by a fraction of a
   * second, and the last tick rarely lands exactly on the final frame.
   */
  static readonly COMPLETION_THRESHOLD: number = 0.97

  /**
   * How close to the end, in seconds, the engine will call the creative
   * finished *by itself*, with no word from the player.
   *
   * A margin rather than a fraction, because the gap that matters is one
   * tick and a tick is a fixed 200ms whether the creative runs ten seconds
   * or sixty. A ratio held the wrong quantity constant: 0.97 stopped a
   * thirty-second ad with nearly a second unplayed — usually where the logo
   * is. {@link COMPLETION_THRESHOLD} asks a different question, whether enough of
   * the creative was *watched*, and keeps its own value.
   */
  static readonly SELF_COMPLETION_MARGIN: number = 0.25

  private _duration: number
  private _watched = 0
  private _isFinished = false

  private readonly fired = new Set<VastTrackingEvent>()
  private readonly firedProgress = new Set<number>()
  private firedImpression = false
  private previous: VastTick | null = null

  /** True when the caller pinned the duration, in which case reported values are ignored. */
  private readonly durationIsPinned: boolean

  /**
   * @param duration Pins the duration; the player's reported figure is then ignored.
   * @param measurementWillRun Whether something is going to execute the ad's
   *   verification resources.
   *
   *   The engine cannot know this — running verification code means an Open
   *   Measurement integration, which lives above this layer — so it is stated by
   *   whoever built the engine. When nothing will run them, the vendors are owed
   *   `verificationNotExecuted` rather than silence.
   */
  constructor(
    private readonly ad: VastAd,
    duration: number | null = null,
    private readonly measurementWillRun: boolean = false,
  ) {
    this._duration = duration ?? ad.linear.duration
    this.durationIsPinned = duration !== null
  }

  /**
   * Starts from `<Duration>` and is replaced by the player's own figure as soon
   * as one is available: the declared value is advisory, and quartiles computed
   * against the wrong length land in the wrong places.
   */
  get duration(): number {
    return this._duration
  }

  /**
   * How far into the creative the viewer has actually got, in seconds.
   *
   * A high-water mark over *covered* timeline, which is the distinction §3.14.1
   * is really drawing with "played continuously": buffering does not skip any
   * of the creative, whereas seeking does.
   *
   * - A stall leaves the playhead where it was; when it resumes, the next
   *   position is still contiguous, so coverage continues.
   * - A forward seek lands beyond what wall-clock time could account for, so it
   *   never extends coverage — and cannot afterwards, because the mark only
   *   moves within reach of where it already was.
   */
  get watched(): number {
    return this._watched
  }

  get isFinished(): boolean {
    return this._isFinished
  }

  // MARK: - Input

  advance(tick: VastTick): VastBeacon[] {
    if (this._isFinished) return []

    // The host replaced the player item mid-ad. Nothing after this point can
    // be attributed to our creative, so stop and report.
    if (tick.itemIsOurs === false) return this.fail(VastError.MEDIA_FILE_DISPLAY_PROBLEM)

    const beacons: VastBeacon[] = []
    try {
      const reported = tick.duration
      if (!this.durationIsPinned && reported !== null && reported > 0) {
        this._duration = reported
      }

      if (tick.rate > 0) {
        beacons.push(...this.startIfNeeded())
        this.advanceWatched(tick)
      }

      beacons.push(...this.quartileBeacons())
      beacons.push(...this.progressBeacons())

      const duration = this._duration
      const selfCompletion = Math.max(
        duration - VastTrackingEngine.SELF_COMPLETION_MARGIN,
        duration * VastTrackingEngine.COMPLETION_THRESHOLD,
      )
      if (duration > 0 && this._watched >= selfCompletion) {
        beacons.push(...this.finish())
      }
    } finally {
      this.previous = tick
    }
    return beacons
  }

  /**
   * The creative is ready and playback is about to begin (§3.14.1 `loaded`).
   *
   * Not host-reportable, and not derivable from a tick either — readiness is
   * something only whoever loaded the media knows.
   */
  creativeDidLoad(): VastBeacon[] {
    if (this._isFinished) return []
    return this.fire('loaded')
  }

  /**
   * The player reported that the item played to its end.
   *
   * This is the authoritative end of the creative. Accumulated watch time cannot
   * be used on its own: every buffering stall is excluded from it by design, so
   * on a stuttering connection the threshold is never reached and the ad would
   * hang on its last frame forever.
   *
   * `complete` still requires the creative to have actually been watched
   * through — reaching the end by seeking is not completion (§3.14.1).
   */
  playbackDidReachEnd(): VastBeacon[] {
    if (this._isFinished) return []
    const beacons = this.progressBeacons()
    if (this._watched >= this._duration * VastTrackingEngine.COMPLETION_THRESHOLD) {
      beacons.push(...this.fire('complete'))
    }
    this._isFinished = true
    return beacons
  }

  /**
   * Playback stopped advancing and is not going to resume.
   *
   * A creative that stalls *after* being watched through is finished, not
   * broken. Reporting 402 for its last few frames would tell the ad server a
   * delivered impression had failed.
   */
  playbackDidStall(): VastBeacon[] {
    if (this._isFinished) return []
    if (this._duration > 0 && this._watched >= this._duration * VastTrackingEngine.COMPLETION_THRESHOLD) {
      return this.playbackDidReachEnd()
    }
    return this.fail(VastError.MEDIA_FILE_TIMEOUT)
  }

  userDidSkip(): VastBeacon[] {
    if (this._isFinished) return []
    this._isFinished = true
    // A skipped ad may still owe progress beacons that its watched time
    // already earned (§3.14.1), so those are emitted before `skip`.
    return [...this.progressBeacons(), ...this.fire('skip')]
  }

  /**
   * Reports a player-operation event the engine cannot observe from ticks —
   * mute, pause, fullscreen and friends (§3.14.1 "Player Operation Metrics").
   *
   * Quartile and lifecycle events are derived from playback instead and are not
   * accepted here, so a host cannot fabricate a billable impression.
   */
  report(event: VastTrackingEvent): VastBeacon[] {
    if (this._isFinished || !VastTrackingEvent.isHostReportable(event)) return []
    return this.fire(event)
  }

  fail(error: VastError): VastBeacon[] {
    if (this._isFinished) return []
    this._isFinished = true
    return this.ad.errors.map((url) => this.beacon({ type: 'error', error }, url))
  }

  /** `<CustomClick>` — an interaction the host saw and the engine cannot. */
  reportCustomClick(): VastBeacon[] {
    if (this._isFinished) return []
    return this.ad.linear.customClicks.map((url) => this.beacon({ type: 'customClick' }, url))
  }

  // MARK: - Rules

  /**
   * Extends coverage to this tick's position when the position is within reach
   * of the mark — that is, when elapsed wall-clock time at the current rate
   * could plausibly have carried the playhead there.
   *
   * A rewind lands below the mark and leaves it untouched. A forward seek lands
   * above what elapsed time allows and is refused, permanently: the mark can
   * only ever advance from where it already is, so no later tick can smuggle
   * the skipped span back in.
   */
  private advanceWatched(tick: VastTick): void {
    const previous = this.previous
    if (previous === null) {
      this._watched = Math.max(this._watched, Math.min(tick.adTime, VastTrackingEngine.SEEK_TOLERANCE))
      return
    }
    const elapsed = Math.max(0, tick.wallClock - previous.wallClock) * tick.rate
    const reachable = this._watched + elapsed + VastTrackingEngine.SEEK_TOLERANCE
    if (tick.adTime > reachable) return
    this._watched = Math.max(this._watched, tick.adTime)
  }

  private startIfNeeded(): VastBeacon[] {
    const beacons: VastBeacon[] = []
    if (!this.firedImpression) {
      this.firedImpression = true
      beacons.push(...this.ad.impressions.map((url) => this.beacon({ type: 'impression' }, url)))
      // Reported with the impression, not later: the vendor is deciding right
      // now whether this session counts as measured.
      beacons.push(...this.verificationsNotExecuted())
      beacons.push(...this.viewabilityUndetermined())
      beacons.push(...this.fire('creativeView'))
    }
    beacons.push(...this.fire('start'))
    return beacons
  }

  /**
   * One beacon per tracker of every vendor whose code will not run.
   *
   * Reason 2 (`RESOURCE_LOAD_ERROR`) never originates here — only whoever tried
   * to load a resource can report that, and by definition nothing tried.
   */
  private verificationsNotExecuted(): VastBeacon[] {
    if (this.measurementWillRun) return []
    const beacons: VastBeacon[] = []
    for (const verification of this.ad.adVerifications) {
      const reason =
        omidResource(verification) === null
          ? VastNotExecutedReason.RESOURCE_NOT_SUPPORTED
          : VastNotExecutedReason.NOT_EXECUTED
      for (const url of verification.notExecutedTrackers) {
        beacons.push(this.beacon({ type: 'verificationNotExecuted', reason }, url))
      }
    }
    return beacons
  }

  /**
   * The only viewability outcome this player can honestly claim.
   *
   * §3.6 offers three, and a player with no viewability measurement can report
   * exactly one of them. Sending nothing at all is the tempting option and the
   * wrong one: an unmeasured impression left silent is counted as measured by
   * whoever asked.
   */
  private viewabilityUndetermined(): VastBeacon[] {
    if (this.measurementWillRun) return []
    const asked = this.ad.viewableImpression
    if (asked === null) return []
    return asked.viewUndetermined.map((url) => this.beacon({ type: 'viewUndetermined' }, url))
  }

  private quartileBeacons(): VastBeacon[] {
    if (this._duration <= 0) return []
    const progress = this._watched / this._duration
    const beacons: VastBeacon[] = []
    for (const [fraction, event] of QUARTILES) {
      if (progress >= fraction) beacons.push(...this.fire(event))
    }
    return beacons
  }

  private progressBeacons(): VastBeacon[] {
    const beacons: VastBeacon[] = []
    this.ad.linear.progressEvents.forEach((event, index) => {
      const offset = skipOffsetSeconds(event.offset, this._duration)
      if (this._watched < offset || this.firedProgress.has(index)) return
      this.firedProgress.add(index)
      beacons.push(this.beacon({ type: 'progress', offset }, event.url))
    })
    return beacons
  }

  private finish(): VastBeacon[] {
    this._isFinished = true
    return this.fire('complete')
  }

  /** Emits an event's URIs at most once when the event is once-only. */
  private fire(event: VastTrackingEvent): VastBeacon[] {
    if (VastTrackingEvent.isOnce(event)) {
      if (this.fired.has(event)) return []
      this.fired.add(event)
    }
    const beacons: VastBeacon[] = []
    for (const equivalent of VastTrackingEvent.equivalents(event)) {
      for (const url of this.ad.linear.trackingEvents[equivalent] ?? []) {
        beacons.push(this.beacon({ type: 'tracking', event }, url))
      }
    }
    return beacons
  }

  private beacon(kind: VastBeaconKind, url: string): VastBeacon {
    return { kind, url, adId: this.ad.id }
  }
}
