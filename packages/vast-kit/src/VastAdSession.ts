import {
  VastError,
  VastException,
  createMediaCapabilities,
  VastMacroExpander,
  VastMediaFileSelector,
  VastPodScheduler,
  VastTagResolver,
  VastTagResolverFailure,
  VastTrackingEngine,
  isSkippable,
  isUiHidden,
  resolvedSkipOffset,
  type VastAd,
  type VastBeacon,
  type VastBeaconKind,
  type VastMacroContext,
  type VastMediaCapabilities,
  type VastMediaFile,
  type VastNotExecutedReason,
  type VastResourceLoader,
  type VastTick,
  type VastTrackingEvent,
  type VastVerification,
} from '@kinodaran/vast-core'
import { VastAdPlayer, type VastAdPlayerListener } from './VastAdPlayer.js'
import {
  DEFAULT_CONFIGURATION,
  SINGLE_AD_POSITION,
  isOutsideBreak,
  VastSkipError,
  type VastAdOutcome,
  type VastAdPosition,
  type VastAdSessionEvents,
  type VastAdSnapshot,
  type VastAdState,
  type VastAdTag,
  type VastBreakPosition,
  type VastBreakResult,
  type VastClock,
  type VastConfiguration,
  type VastSkipPresentation,
} from './VastAdSessionTypes.js'
import type { VastBeaconTransport } from './VastBeaconTransport.js'
import type { VastContentPlayer } from './VastContentPlayer.js'
import { VastFetchLoader, VastFetchTransport } from './VastHttp.js'
import { VastLog } from './VastLog.js'
import type { VastMeasurement, VastMeasurementEvent } from './VastMeasurement.js'
import { VastMediaSessionLock } from './VastMediaSessionLock.js'
import { vastStringsFor } from './VastStrings.js'
import { VastVideoClock } from './VastVideoClock.js'

export interface VastAdSessionOptions {
  /**
   * The element the break is drawn over — the player's own box. For Video.js,
   * the player element (`player.el()`), so the break follows it into fullscreen.
   */
  readonly container: HTMLElement
  /**
   * The content the break interrupts. Optional: without one the host pauses
   * and resumes its own player around `playBreak`. `vast-videojs` supplies one
   * for Video.js, and `htmlVideoContent` one for a plain `<video>`.
   */
  readonly content?: VastContentPlayer | null
  readonly configuration?: Partial<VastConfiguration>
  /** What the session reads from the page, replaceable so a test can script it. */
  readonly environment?: Partial<VastEnvironment>
}

/** What the session reads from the page, kept apart so a test can supply it. */
export interface VastEnvironment {
  readonly transport: VastBeaconTransport
  readonly loader: VastResourceLoader
  /** Monotonic seconds, for the stall watchdog. */
  readonly uptimeSeconds: () => number
  /** Whether the page is on screen. */
  readonly isPageVisible: () => boolean
  /** Calls back when the page's visibility changes; returns the way to stop. */
  readonly onVisibilityChange: (callback: () => void) => () => void
  /** A television browser (Tizen, webOS, …), where a transparent click layer can never take focus. */
  readonly isTelevision: boolean
  /** Whether this browser can decode a MIME type in a `<video>` element. */
  readonly canPlayType: (mimeType: string) => boolean
  /** Device pixels of the screen, for media selection before the container has a size. */
  readonly screenSize: () => { width: number; height: number } | null
  /** `[PAGEURL]` and `[DOMAIN]`. */
  readonly pageUrl: string | null
  /** `[DEVICEUA]` when the host supplied none: a browser has an honest one to give. */
  readonly userAgent: string | null
  /** The media controls' name for an ad with no `<AdTitle>`, in the page's language. */
  readonly nowPlayingTitle: string
  /** One `[TRANSACTIONID]` per break. */
  readonly randomId: () => string
}

/** One ad given a place in the break. */
interface Slot {
  readonly index: number
  readonly ad: VastAd
  readonly mediaFile: VastMediaFile
  readonly engine: VastTrackingEngine
  loadedReported: boolean
  started: boolean
  skipped: boolean
  finished: boolean
  outcome: VastAdOutcome | null
  clock: VastClock | null
  loadTimer: ReturnType<typeof setTimeout> | null
  /** Why the creative ended, when the session decided it rather than the engine — a stall. */
  failure: VastError | null
  done: ((started: boolean) => void) | null
}

interface BreakRequest {
  readonly tag: VastAdTag
  readonly position: VastBreakPosition | null
  readonly resolve: (result: VastBreakResult) => void
}

type Hold = 'offScreen'

/** Thrown inside the session when the resolution budget runs out. */
class BudgetExceeded extends Error {}

/**
 * Plays VAST breaks over the host's player and reports tracking.
 *
 * The break plays in a `<video>` of the session's own, laid over the content —
 * the content is paused around it, never reloaded, so DRM and adaptive streams
 * are untouched. The session decides what is reported and when; it owns no UI
 * of its own beyond that element, and publishes its state for the overlay (or
 * the host's own UI) to draw from: {@link getSnapshot}/{@link subscribe}, and
 * the events behind {@link on}.
 *
 * Keep one session for the life of the player. Rebuilt on every render, it
 * restarts the break, and the ad server is sent the same impression twice.
 */
export class VastAdSession {
  readonly configuration: VastConfiguration

  /**
   * Third-party measurement, if anything is going to execute the ad's
   * `<AdVerifications>`. Set it before the break starts.
   *
   * Leaving this `null` is not a gap: the SDK then reports
   * `verificationNotExecuted` to every vendor that asked, which is the honest
   * answer and the whole reason the field is optional.
   */
  measurement: VastMeasurement | null = null

  /** The element the creative plays in, and the layer the overlay mounts into. */
  readonly adPlayer: VastAdPlayer

  private readonly content: VastContentPlayer | null
  private readonly environment: VastEnvironment
  private readonly resolver: VastTagResolver
  private readonly macros = new VastMacroExpander()
  private readonly selector = new VastMediaFileSelector()
  private readonly mediaSessionLock: VastMediaSessionLock

  // MARK: - Published state

  private state: VastAdState = { type: 'idle' }
  private currentAd: VastAd | null = null
  private adPosition: VastAdPosition = SINGLE_AD_POSITION
  private remainingTime = 0
  private canSkip = false
  private timeUntilSkip: number | null = null
  private isMuted = false
  private mutedByAutoplayPolicy = false
  private snapshot: VastAdSnapshot
  private readonly subscribers = new Set<() => void>()
  private readonly handlers = new Map<keyof VastAdSessionEvents, Set<(...args: never[]) => void>>()

  // MARK: - The break in progress

  private readonly queue: BreakRequest[] = []
  private running = false
  private destroyed = false
  private contentPaused = false
  private scheduler: VastPodScheduler | null = null
  private activeSlot: Slot | null = null
  private pendingSlot: Slot | null = null
  private lastOutcome: VastAdOutcome = { type: 'failed', error: VastError.UNDEFINED }
  private resolution: AbortController | null = null

  /** The last tick seen, so a beacon can report where the playhead was. */
  private lastTick: VastTick | null = null

  /**
   * `[TRANSACTIONID]` — one value for one break, so an ad server can tie a
   * break's beacons together. Regenerated per break: two breaks on one page
   * are two transactions.
   */
  private transactionId: string | null = null

  /** Where this break sits, as the host said when it asked for it. */
  private breakPosition: VastBreakPosition | null = null

  /**
   * Why the ad is being held, as distinct from a pause anyone chose — so it is
   * neither reported nor shown as one.
   */
  private readonly holds = new Set<Hold>()

  /** Whether the session paused the element for a hold, and so owes it a restart. */
  private heldPlayback = false

  private readonly skipControlHosts = new Set<() => { width: number; height: number } | null>()
  private reportedSkipControlProblem = false
  private readonly stopObservingVisibility: () => void

  constructor(options: VastAdSessionOptions) {
    this.configuration = { ...DEFAULT_CONFIGURATION, ...options.configuration }
    this.environment = { ...defaultEnvironment(this.configuration), ...options.environment }
    this.content = options.content ?? null
    this.adPlayer = new VastAdPlayer(options.container)
    this.resolver = new VastTagResolver(
      this.environment.loader,
      this.configuration.maxWrapperDepth,
      this.configuration.wrapperTimeoutSeconds,
    )
    this.mediaSessionLock = new VastMediaSessionLock(this.environment.nowPlayingTitle)
    this.snapshot = this.makeSnapshot()

    /**
     * An ad nobody can see must not go on playing. A background tab keeps
     * decoding video with sound, so a break left running behind another tab
     * would earn quartiles from a viewer who was not there. The session holds
     * the ad instead: not a §3.14.1 `pause`, because nobody paused, and resumed
     * on its own when the page comes back.
     */
    this.stopObservingVisibility = this.environment.onVisibilityChange(() =>
      this.notePageVisible(this.environment.isPageVisible()),
    )

    // Whatever an earlier page left in the retry queue goes out now, while the
    // network is evidently up.
    const transport = this.environment.transport
    if (transport instanceof VastFetchTransport) void transport.flushPending().catch(() => undefined)
  }

  // MARK: - Reading the state

  /** Everything the session publishes, as one immutable value. Same object until something changes. */
  readonly getSnapshot = (): VastAdSnapshot => this.snapshot

  /** Calls back on every change to {@link getSnapshot}. Returns the way to stop. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  /** Subscribes to one of the session's events. Returns the way to stop. */
  on<K extends keyof VastAdSessionEvents>(event: K, handler: VastAdSessionEvents[K]): () => void {
    let set = this.handlers.get(event)
    if (!set) this.handlers.set(event, (set = new Set()))
    const entry = handler as (...args: never[]) => void
    set.add(entry)
    return () => set.delete(entry)
  }

  // MARK: - Breaks

  /**
   * Call from inside a user gesture — the play button's click handler — before
   * the first break, so a browser that ties playback to gestures (iOS Safari)
   * lets the ad start with sound. See {@link VastAdPlayer.prepare}.
   */
  prepare(): void {
    this.adPlayer.prepare()
  }

  /**
   * Plays a break: right away when nothing else is on screen, and after the
   * break on screen when one is. Several asked for at once play one after
   * another, in the order they were asked for, and the content comes back only
   * after the last.
   *
   * A `preroll` holds the content from the moment it is asked for — the
   * content is waiting for it. Any other break leaves the content playing while
   * its response comes back, and stops it only once there is an ad to show:
   * nothing should look as though it stopped for a break that turns out empty.
   *
   * Never rejects. The promise settles when the break is over, however it went.
   */
  playBreak(tag: VastAdTag, options: { position?: VastBreakPosition } = {}): Promise<VastBreakResult> {
    if (this.destroyed) return Promise.resolve({ outcome: { type: 'failed', error: VastError.UNDEFINED }, adsStarted: 0 })
    return new Promise((resolve) => {
      this.queue.push({ tag, position: options.position ?? null, resolve })
      this.publish()
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0 && !this.destroyed) {
        const request = this.queue.shift()!
        this.publish()
        let result: VastBreakResult
        try {
          result = await this.runBreak(request)
        } catch (error) {
          VastLog.warning(`break ended unexpectedly: ${String(error)}`)
          result = { outcome: { type: 'failed', error: VastError.UNDEFINED }, adsStarted: 0 }
          this.endBreak(true)
        }
        request.resolve(result)
      }
    } finally {
      this.running = false
    }
  }

  private async runBreak(request: BreakRequest): Promise<VastBreakResult> {
    this.breakPosition = request.position
    const blocking = request.position === 'preroll' || this.contentPaused
    if (blocking) {
      this.pauseContent()
      this.setState({ type: 'loading' })
    }
    this.transactionId = this.environment.randomId()

    let ads: readonly VastAd[]
    try {
      ads = (await this.withResolutionBudget((signal) => this.resolve(request.tag, signal))).ads
    } catch (error) {
      if (this.destroyed) return this.cancelled()
      if (error instanceof VastTagResolverFailure) {
        // The wrappers traversed are owed an error request, sent without
        // waiting: the content may be waiting on this break.
        this.send(error.beacons, null)
        return this.failBreak(error.error, blocking)
      }
      if (error instanceof BudgetExceeded) {
        // No beacons: only the chain knows which URIs are owed, and cutting it
        // off from outside is exactly the case where it cannot say.
        return this.failBreak(VastError.WRAPPER_TIMEOUT, blocking)
      }
      return this.failBreak(VastError.WRAPPER_GENERAL, blocking)
    }
    if (ads.length === 0) return this.failBreak(VastError.NO_VAST_RESPONSE_AFTER_WRAPPERS, blocking)

    const scheduler = new VastPodScheduler(ads)
    this.scheduler = scheduler
    const slots: Slot[] = []
    for (let ad = scheduler.next(); ad; ad = scheduler.next()) {
      const slot = this.plan(ad, slots.length) ?? this.substitute(slots.length)
      if (slot) slots.push(slot)
    }
    if (slots.length === 0) {
      this.scheduler = null
      return this.failBreak(this.lastOutcomeError(), blocking, false)
    }

    this.pauseContent()
    this.adPlayer.show()
    let started = 0
    for (let index = 0; index < slots.length && !this.destroyed; index++) {
      let slot: Slot | null = slots[index]!
      while (slot && !this.destroyed) {
        if (await this.playSlot(slot, slots.length)) {
          started++
          break
        }
        // §3.3.1: an unplayed stand-alone ad takes the failed one's turn. It
        // takes the same place in the break rather than joining the end, so the
        // badge a viewer has already read ("Ad 2/3") stays true.
        slot = this.substitute(index)
      }
    }
    if (this.destroyed) return this.cancelled()
    this.endBreak(true)
    return { outcome: this.lastOutcome, adsStarted: started }
  }

  private resolve(tag: VastAdTag, signal: AbortSignal) {
    if (typeof tag === 'string') return this.resolver.resolveTag(tag, signal)
    if ('url' in tag) return this.resolver.resolveTag(tag.url, signal)
    return this.resolver.resolveXml(tag.xml, tag.baseUrl ?? null, signal)
  }

  /**
   * The whole response, not one hop: `wrapperTimeoutSeconds` already bounds a
   * single fetch, and five of those in series is long past the point where a
   * viewer stops believing an ad is coming.
   */
  private async withResolutionBudget<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    this.resolution = controller
    const budget = this.configuration.resolutionTimeoutSeconds
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      if (budget <= 0) return await work(controller.signal)
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new BudgetExceeded())
        }, budget * 1000)
      })
      return await Promise.race([work(controller.signal), expired])
    } finally {
      if (timer !== null) clearTimeout(timer)
      if (this.resolution === controller) this.resolution = null
    }
  }

  /**
   * What one ad needs before it can be put in the break: a creative this
   * browser can decode, and — when it is skippable — somebody to draw the skip.
   * `null` when it cannot play; its `<Error>` URIs have then been told why.
   */
  private plan(ad: VastAd, index: number): Slot | null {
    // §2.3: "nor should the media player play the Skippable Ad as a Linear Ad
    // (without skip controls)". A host that cannot offer the control is told
    // to expect a trafficking error, not handed a compliance breach.
    if (isSkippable(ad) && this.skipPresentation(ad) === 'unsupported') {
      this.failUnplayed(ad, VastError.TRAFFICKING)
      return null
    }
    let file: VastMediaFile
    try {
      file = this.selector.select(ad.linear.mediaFiles, this.capabilities(ad.linear.mediaFiles))
    } catch (error) {
      if (!(error instanceof VastException)) throw error
      this.failUnplayed(ad, VastError.NO_SUPPORTED_MEDIA_FILE)
      return null
    }
    return {
      index,
      ad,
      mediaFile: file,
      engine: new VastTrackingEngine(ad, null, this.measurement !== null),
      loadedReported: false,
      started: false,
      skipped: false,
      finished: false,
      outcome: null,
      clock: null,
      loadTimer: null,
      failure: null,
      done: null,
    }
  }

  /** §3.3.1: a failed pod member is replaced by an unplayed stand-alone ad, if the response had one. */
  private substitute(index: number): Slot | null {
    const scheduler = this.scheduler
    if (!scheduler) return null
    for (let spare = scheduler.substituteForFailure(); spare; spare = scheduler.substituteForFailure()) {
      const slot = this.plan(spare, index)
      if (slot) return slot
    }
    return null
  }

  private failUnplayed(ad: VastAd, error: VastError): void {
    const engine = new VastTrackingEngine(ad, null, this.measurement !== null)
    this.send(engine.fail(error), null, ad)
    this.lastOutcome = { type: 'failed', error }
    this.emit('adFailed', error, ad)
  }

  private lastOutcomeError(): VastError {
    return this.lastOutcome.type === 'failed' ? this.lastOutcome.error : VastError.UNDEFINED
  }

  /**
   * The response produced no ad. A pre-roll that fails finishes the session's
   * state; a break asked for during the content leaves the state as the content
   * has it — only the listener hears, because nothing on screen changed.
   */
  private failBreak(error: VastError, blocking: boolean, notify = true): VastBreakResult {
    this.lastOutcome = { type: 'failed', error }
    if (notify) this.emit('adFailed', error, null)
    this.endBreak(blocking)
    return { outcome: this.lastOutcome, adsStarted: 0 }
  }

  private cancelled(): VastBreakResult {
    return { outcome: { type: 'failed', error: VastError.UNDEFINED }, adsStarted: 0 }
  }

  /**
   * The break is over. The content comes back only when no other break is
   * waiting — two breaks asked for together are one interruption to the viewer.
   */
  private endBreak(changesState: boolean): void {
    this.stopTicking()
    this.scheduler = null
    this.activeSlot = null
    this.pendingSlot = null
    this.adPlayer.unload()
    this.adPlayer.hide()
    this.mediaSessionLock.release()
    if (this.queue.length === 0) this.resumeContent()
    this.resetPublishedAd()
    if (changesState) {
      this.state = { type: 'finished', outcome: this.lastOutcome }
      this.publish()
      this.emit('allAdsFinished')
    } else {
      this.publish()
    }
  }

  private pauseContent(): void {
    if (this.contentPaused) return
    this.contentPaused = true
    // A break starts as loud as what it interrupted, and never louder than the viewer chose.
    this.isMuted = this.content?.muted ?? false
    this.mutedByAutoplayPolicy = false
    try {
      this.content?.pauseForBreak()
    } catch (error) {
      VastLog.warning(`content could not pause for the break: ${String(error)}`)
    }
  }

  private resumeContent(): void {
    if (!this.contentPaused) return
    this.contentPaused = false
    try {
      this.content?.resumeAfterBreak()
    } catch (error) {
      VastLog.warning(`content could not resume after the break: ${String(error)}`)
    }
  }

  // MARK: - One creative

  private playSlot(slot: Slot, total: number): Promise<boolean> {
    return new Promise((done) => {
      slot.done = done
      this.pendingSlot = slot
      // The previous creative's skip is not this one's: a host UI reading the
      // snapshot between two ads must not offer a skip there is nothing to take.
      this.canSkip = false
      this.timeUntilSkip = null
      this.state = { type: 'loading' }
      this.publish()
      const listener: VastAdPlayerListener = {
        loaded: () => this.slotPrepared(slot),
        started: () => this.slotStarted(slot, total),
        playbackChanged: (wants) => this.notePlayback(slot, wants),
        ended: () => this.slotLeft(slot, true),
        failed: (error) => this.slotFailed(slot, error),
      }
      const timeout = this.configuration.mediaLoadTimeoutSeconds
      if (timeout > 0) {
        slot.loadTimer = setTimeout(() => {
          if (!slot.started) this.slotFailed(slot, VastError.MEDIA_FILE_TIMEOUT)
        }, timeout * 1000)
      }
      const volume = this.content?.volume ?? 1
      void this.adPlayer.load(slot.mediaFile.url, listener, { volume, muted: this.isMuted }).then((result) => {
        if (slot.finished) return
        if (result === 'mutedByPolicy') {
          this.isMuted = true
          this.mutedByAutoplayPolicy = true
          this.publish()
        } else if (result === 'refused') {
          // Autoplay is off and nothing has touched the element: the ad cannot
          // be shown, which is a display problem rather than a missing file.
          this.slotFailed(slot, VastError.MEDIA_FILE_DISPLAY_PROBLEM)
        }
      })
    })
  }

  /** The element has the creative ready, which is what `loaded` means (§3.14.1). */
  private slotPrepared(slot: Slot): void {
    if (slot.loadedReported || slot.finished) return
    slot.loadedReported = true
    this.send(slot.engine.creativeDidLoad(), slot)
  }

  /** The element could not show the creative. */
  private slotFailed(slot: Slot, error: VastError): void {
    if (slot.finished) return
    if (this.activeSlot === slot) this.stopTicking()
    this.clearLoadTimer(slot)
    this.send(slot.engine.fail(error), slot)
    slot.finished = true
    const outcome: VastAdOutcome = { type: 'failed', error }
    slot.outcome = outcome
    this.lastOutcome = outcome
    this.emit('adFailed', error, slot.ad)
    if (this.activeSlot === slot) {
      // A hold belongs to the creative it was put on, however that creative
      // ended — left in place, the next pod member would start unheld on a
      // hidden page and earn quartiles from nobody.
      this.holds.clear()
      this.heldPlayback = false
      this.emit('adFinished', slot.ad, outcome)
      this.measurement?.finish()
      this.activeSlot = null
    }
    this.adPlayer.pause()
    this.complete(slot)
  }

  /** The element is now showing this creative. */
  private slotStarted(slot: Slot, total: number): void {
    if (slot.finished) return
    this.clearLoadTimer(slot)
    slot.started = true
    this.activeSlot = slot
    this.pendingSlot = null
    this.reportedSkipControlProblem = false
    this.currentAd = slot.ad
    this.adPosition = { index: slot.index + 1, total }
    this.canSkip = false
    this.timeUntilSkip = resolvedSkipOffset(slot.ad.linear)
    // Seeded from <Duration> so the overlay reads the creative's length while
    // it buffers, instead of showing 0s.
    this.remainingTime = slot.ad.linear.duration
    this.lastTick = null
    this.slotPrepared(slot)

    this.state = { type: 'playing' }
    this.publish()
    this.verifyClickPath(slot.ad)
    // Before the impression: a measurement session has to exist for the
    // impression it is being asked to attest to.
    this.measurement?.begin({
      ad: slot.ad,
      verifications: slot.ad.adVerifications,
      videoElement: this.adPlayer.video,
      slotElement: this.adPlayer.layer,
    })
    this.emit('adStarted', slot.ad, this.adPosition)
    if (this.configuration.mediaSession === 'describesAd') {
      this.mediaSessionLock.engage(slot.ad, { play: () => this.resume(), pause: () => this.pause() })
    }
    if (!this.environment.isPageVisible()) this.hold('offScreen')

    const clock = this.configuration.clock ?? new VastVideoClock(this.adPlayer.video, slot.mediaFile.url)
    slot.clock = clock
    let lastAdvance = this.environment.uptimeSeconds()
    let lastPosition = -1
    clock.start((tick) => {
      if (this.activeSlot !== slot || slot.finished) return
      this.lastTick = tick
      this.send(slot.engine.advance(tick), slot)
      this.update(tick, slot.ad)

      const now = this.environment.uptimeSeconds()
      if (tick.adTime > lastPosition + ADVANCE_EPSILON_SECONDS) {
        lastPosition = tick.adTime
        lastAdvance = now
      } else if (!this.adPlayer.wantsPlayback || this.heldPlayback) {
        // Paused, or held: the playhead is meant to be still, so the clock for
        // "stuck" does not run. Without this a viewer who paused for longer than
        // the stall timeout had the ad written off as unplayable.
        lastAdvance = now
      } else if (now - lastAdvance > STALL_TIMEOUT_SECONDS) {
        this.stall(slot)
        return
      }

      // Finished by coverage: the engine has reported `complete`. The element
      // plays the last frames on its own and ends; nothing further needs a tick.
      if (slot.engine.isFinished) this.stopTicking()
    })
  }

  /**
   * The element left this creative. `naturally` is the creative playing to its
   * end, which is the authoritative signal that it is over — watch time alone
   * cannot be trusted for this, because stalls are excluded from it by design.
   */
  private slotLeft(slot: Slot, naturally: boolean): void {
    if (slot.finished) return
    this.stopTicking()
    // A creative left by anything but its own end is not ours to account for any more (405).
    const beacons = naturally ? slot.engine.playbackDidReachEnd() : slot.engine.fail(VastError.MEDIA_FILE_DISPLAY_PROBLEM)
    this.send(beacons, slot)
    this.endSlot(slot)
  }

  /**
   * The element started or stopped. A stop the session did not cause is still a
   * pause the ad server is owed (§3.14.1) — a headset button, the OS media hub,
   * the host calling `pause()`.
   */
  private notePlayback(slot: Slot, wantsPlayback: boolean): void {
    if (this.activeSlot !== slot || slot.finished || this.heldPlayback) return
    if (wantsPlayback) {
      if (this.state.type !== 'paused') return
      this.send(slot.engine.report('resume'), slot)
      this.setState({ type: 'playing' })
      return
    }
    if (this.state.type !== 'playing') return
    // The creative running out stops the element like anything else does, and
    // `pause` after `complete` is a sequence no ad server should be sent.
    if (slot.engine.isFinished || this.remainingTime <= END_OF_CREATIVE_MARGIN_SECONDS) return
    this.send(slot.engine.report('pause'), slot)
    this.setState({ type: 'paused' })
  }

  /**
   * The playhead stuck while the element claimed to be playing. A creative
   * already watched through counts as complete — the engine says so — and
   * anything else is a 402, which the host hears whether or not the response
   * gave an `<Error>` URI to tell, and which is the outcome the break reports.
   */
  private stall(slot: Slot): void {
    this.stopTicking()
    const engine = slot.engine
    const watchedThrough = engine.duration > 0 && engine.watched >= engine.duration * VastTrackingEngine.COMPLETION_THRESHOLD
    this.send(engine.playbackDidStall(), slot)
    if (!watchedThrough) {
      slot.failure = VastError.MEDIA_FILE_TIMEOUT
      this.emit('adFailed', VastError.MEDIA_FILE_TIMEOUT, slot.ad)
    }
    this.endSlot(slot)
  }

  private endSlot(slot: Slot): void {
    if (slot.finished) return
    this.stopTicking()
    this.clearLoadTimer(slot)
    // A hold belongs to the creative it was put on: the next one starts clean
    // and is held again only if the reason still stands.
    this.holds.clear()
    this.heldPlayback = false
    slot.finished = true
    const outcome = this.outcomeFor(slot)
    slot.outcome = outcome
    this.lastOutcome = outcome
    // Exactly once per `begin`, whatever the outcome: a measurement session
    // left open counts against the vendor, not against us.
    this.measurement?.finish()
    this.emit('adFinished', slot.ad, outcome)
    if (this.activeSlot === slot) this.activeSlot = null
    this.adPlayer.pause()
    this.complete(slot)
  }

  /** A skip beats everything; otherwise the creative counts as completed only if the engine actually finished it. */
  private outcomeFor(slot: Slot): VastAdOutcome {
    if (slot.skipped) return { type: 'skipped' }
    if (slot.failure !== null) return { type: 'failed', error: slot.failure }
    const engine = slot.engine
    if (!engine.isFinished) return { type: 'failed', error: VastError.MEDIA_FILE_TIMEOUT }
    return engine.watched >= engine.duration * VastTrackingEngine.COMPLETION_THRESHOLD
      ? { type: 'completed' }
      : { type: 'failed', error: VastError.MEDIA_FILE_DISPLAY_PROBLEM }
  }

  private complete(slot: Slot): void {
    if (this.pendingSlot === slot) this.pendingSlot = null
    const done = slot.done
    slot.done = null
    done?.(slot.started)
  }

  private clearLoadTimer(slot: Slot): void {
    if (slot.loadTimer !== null) clearTimeout(slot.loadTimer)
    slot.loadTimer = null
  }

  private stopTicking(): void {
    this.activeSlot?.clock?.stop()
  }

  /** Publishes the state the overlay and the listener render from. */
  private update(tick: VastTick, ad: VastAd): void {
    const duration = tick.duration ?? ad.linear.duration
    this.remainingTime = Math.max(0, duration - tick.adTime)
    this.emit('adProgress', ad, tick.adTime, duration)

    const unlockAt = resolvedSkipOffset(ad.linear)
    if (unlockAt === null) {
      this.timeUntilSkip = null
      this.publish()
      return
    }
    const remainingUntilSkip = Math.max(0, unlockAt - tick.adTime)
    this.timeUntilSkip = remainingUntilSkip > 0 ? remainingUntilSkip : null

    if (remainingUntilSkip <= 0 && !this.canSkip) {
      this.canSkip = true
      this.publish()
      this.verifySkipSurface(ad)
      this.emit('skipAvailable', ad)
      return
    }
    this.publish()
  }

  // MARK: - Holds

  private notePageVisible(visible: boolean): void {
    if (visible) this.release('offScreen')
    else this.hold('offScreen')
  }

  private hold(reason: Hold): void {
    const slot = this.activeSlot
    if (!slot || slot.finished) return
    this.holds.add(reason)
    if (this.heldPlayback || this.state.type !== 'playing' || !this.adPlayer.wantsPlayback) return
    this.heldPlayback = true
    this.adPlayer.pause()
  }

  private release(reason: Hold): void {
    this.holds.delete(reason)
    if (this.holds.size > 0 || !this.heldPlayback) return
    this.heldPlayback = false
    this.adPlayer.play()
  }

  // MARK: - Host actions

  /**
   * Skips the ad on screen.
   *
   * @throws VastSkipError when no ad is playing, the ad is not skippable, or
   *   `skipoffset` has not elapsed yet. Never silently ignores the request —
   *   playing a skippable ad without honouring its skip control violates §2.3.
   */
  skip(): void {
    const slot = this.activeSlot
    if (!slot) throw VastSkipError.noActiveAd()
    if (!isSkippable(slot.ad)) throw VastSkipError.notSkippable()
    if (!this.canSkip) throw VastSkipError.notYetAvailable(this.timeUntilSkip ?? 0)

    slot.skipped = true
    this.send(slot.engine.userDidSkip(), slot)
    this.endSlot(slot)
  }

  /**
   * Records a click on the creative.
   *
   * Fires every `<ClickTracking>` URI and returns the `<ClickThrough>`
   * destination. Opening it is the caller's decision — {@link openClickThrough}
   * does it the usual way.
   */
  click(): string | null {
    const slot = this.activeSlot
    if (!slot) return null
    this.send(
      slot.ad.linear.clickTracking.map((url) => ({ kind: { type: 'clickTracking' } as const, url, adId: slot.ad.id })),
      slot,
    )
    return slot.ad.linear.clickThrough
  }

  /**
   * {@link click}, then opens the destination in a new tab. Call it from the
   * click handler itself: browsers only let a page open a tab inside a gesture.
   * The tab taking focus hides this page, which holds the ad until the viewer
   * is back.
   */
  openClickThrough(): string | null {
    const url = this.click()
    if (url && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
    return url
  }

  /**
   * Reports an interaction that opens nothing — `<CustomClick>` (§3.10.3).
   * Separate from {@link click} on purpose: real tags carry both, and firing one
   * for the other misreports both.
   */
  reportCustomClick(): void {
    const slot = this.activeSlot
    if (slot) this.send(slot.engine.reportCustomClick(), slot)
  }

  /**
   * Reports an event the SDK cannot observe for itself — fullscreen and the rest
   * of §3.14.1's player operation metrics.
   *
   * Quartiles, `start` and `complete` are derived from observed playback and are
   * refused here, so a host cannot fabricate a billable event.
   */
  report(event: VastTrackingEvent): void {
    const slot = this.activeSlot
    if (slot) this.send(slot.engine.report(event), slot)
  }

  /** Pauses the ad on screen. Reported as §3.14.1 `pause` when the element confirms it. */
  pause(): void {
    if (this.state.type === 'playing') this.adPlayer.pause()
  }

  /** Resumes an ad paused by {@link pause} or by the viewer. Reported as `resume`. */
  resume(): void {
    if (this.state.type === 'paused') this.adPlayer.play()
  }

  /**
   * Turns the ad's sound off or on, as the viewer asked. Reported as §3.14.1
   * `mute`/`unmute` — unlike the muted start an autoplay policy imposes, which
   * nobody chose.
   */
  setMuted(muted: boolean): void {
    if (this.isMuted === muted && !(this.mutedByAutoplayPolicy && !muted)) return
    this.isMuted = muted
    if (!muted) this.mutedByAutoplayPolicy = false
    this.adPlayer.setMuted(muted)
    this.publish()
    this.report(muted ? 'mute' : 'unmute')
  }

  /** Reports a vendor's resource as having failed to load — only measurement can know this. */
  reportVerificationNotExecuted(verification: VastVerification, reason: VastNotExecutedReason = 2): void {
    const slot = this.activeSlot
    if (!slot) return
    this.send(
      verification.notExecutedTrackers.map((url) => ({
        kind: { type: 'verificationNotExecuted', reason } as const,
        url,
        adId: slot.ad.id,
      })),
      slot,
    )
  }

  /**
   * A skip control is drawn somewhere, and this is how to measure it. The
   * overlay registers itself; a host drawing its own control under `sdk`
   * presentation registers too. Returns the way to unregister.
   */
  registerSkipControl(measure: () => { width: number; height: number } | null): () => void {
    this.skipControlHosts.add(measure)
    return () => this.skipControlHosts.delete(measure)
  }

  /**
   * Ends the session: the break in progress, every pending break, and the ad
   * element. Content held for a break gets its controls back and plays on —
   * a session torn down mid-break must not leave the film frozen behind it.
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopTicking()
    this.resolution?.abort()
    this.stopObservingVisibility()
    const active = this.activeSlot ?? this.pendingSlot
    if (active) {
      this.clearLoadTimer(active)
      if (this.activeSlot === active && !active.finished) this.measurement?.finish()
      active.finished = true
      this.complete(active)
    }
    for (const request of this.queue.splice(0)) request.resolve(this.cancelled())
    this.mediaSessionLock.release()
    this.adPlayer.destroy()
    this.resumeContent()
    this.activeSlot = null
    this.pendingSlot = null
    this.scheduler = null
    this.resetPublishedAd()
    this.state = { type: 'idle' }
    this.publish()
    this.subscribers.clear()
  }

  // MARK: - Policy

  /** A television browser, where controls are reached by remote focus rather than a pointer. */
  get isTelevision(): boolean {
    return this.environment.isTelevision
  }

  /** Whether the ad on screen must be drawn by the host: the host allowed it *and* this response asked for it. */
  suppressesAdUi(ad: VastAd | null = this.currentAd): boolean {
    return this.configuration.allowsHiddenUi && ad !== null && isUiHidden(ad)
  }

  /** Hidden UI hands the current creative's controls to the host. Otherwise the configured policy stands. */
  skipPresentation(ad: VastAd | null = this.currentAd): VastSkipPresentation {
    const drawnBySdk = this.configuration.skipPresentation === 'sdk'
    return this.suppressesAdUi(ad) && drawnBySdk ? 'host' : this.configuration.skipPresentation
  }

  /**
   * The surface the creative will actually be shown on, used to rank media
   * files. The container is the player's box, so asking it is asking the right
   * thing; the whole screen is only the fallback for before it has been laid out.
   */
  private capabilities(files: readonly VastMediaFile[]): VastMediaCapabilities {
    const size = this.containerPixels() ?? this.environment.screenSize() ?? { width: 1280, height: 720 }
    // What this browser says it decodes, asked of the files actually on offer
    // rather than assumed: the ad plays in a plain `<video>`, with no hls.js
    // behind it, so HLS counts only where the browser plays it natively. A
    // format chosen and then failed costs a 405 where refusing it would have
    // let an alternative play.
    const supported = new Set<string>()
    for (const file of files) {
      const type = file.mimeType.toLowerCase()
      if (!supported.has(type) && this.environment.canPlayType(file.mimeType)) supported.add(type)
    }
    return createMediaCapabilities({
      width: size.width,
      height: size.height,
      supportedMimeTypes: supported,
      supportsStreaming: this.environment.canPlayType('application/vnd.apple.mpegurl'),
    })
  }

  private containerPixels(): { width: number; height: number } | null {
    const rect = this.adPlayer.container.getBoundingClientRect()
    const ratio = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
    const width = Math.round(rect.width * ratio)
    const height = Math.round(rect.height * ratio)
    return width > 1 && height > 1 ? { width, height } : null
  }

  // MARK: - Compliance

  /**
   * The one compliance promise the SDK cannot verify on its own: with `sdk`
   * presentation, a skippable ad is offered a skip control (§2.3), and that
   * control has to be somewhere a viewer can reach. Judged only when the
   * control is due — asking earlier cannot tell "missing" from "not laid out
   * yet". Reported, never fatal: this is a heuristic about someone else's page.
   */
  private verifySkipSurface(ad: VastAd): void {
    if (this.skipPresentation(ad) !== 'sdk' || !isSkippable(ad) || this.suppressesAdUi(ad)) return
    if (this.reportedSkipControlProblem) return
    let reason: string | null = null
    if (this.skipControlHosts.size === 0) {
      reason =
        'no VastAdOverlay is mounted, so the skip control this ad requires cannot be shown. ' +
        'Mount one over the player, or set skipPresentation to "host" or "unsupported".'
    } else {
      const sizes = [...this.skipControlHosts].map((measure) => measure())
      const usable = sizes.some((s) => s !== null && s.width >= MINIMUM_TARGET_PX && s.height >= MINIMUM_TARGET_PX)
      if (!usable) {
        const seen = sizes.find((s) => s !== null)
        reason = seen
          ? `the skip control drew at ${Math.round(seen.width)}×${Math.round(seen.height)}px, too small for a viewer to hit.`
          : 'the skip control is not rendered — hidden, detached, or covered by display: none.'
      }
    }
    if (!reason) return
    this.reportedSkipControlProblem = true
    VastLog.warning(`skip control unavailable: ${reason}`)
    this.emit('skipControlUnavailable', ad, reason)
  }

  /**
   * §3.10.1 makes ClickThrough support Required, and the surface is how the SDK
   * provides it — except on a television, where a transparent layer under a
   * remote's D-pad takes no focus. Saying so is the difference between a host
   * choosing `host` and a host shipping an ad nobody can click.
   */
  private verifyClickPath(ad: VastAd): void {
    if (!this.environment.isTelevision || this.configuration.clickPresentation !== 'surface') return
    if (ad.linear.clickThrough === null) return
    const reason =
      'clickPresentation is "surface", but a TV has no pointer and a transparent layer cannot take ' +
      'remote focus, so this ad has no click path. Set clickPresentation to "host" and call click() from a ' +
      'focusable control of your own, or to "disabled" to opt out knowingly.'
    VastLog.warning(`click path unavailable: ${reason}`)
    this.emit('clickThroughUnavailable', ad, reason)
  }

  // MARK: - Beacons

  /**
   * Hands beacons to the transport without waiting for them.
   *
   * Never awaited: a beacon is a request to somebody else's server, and
   * awaiting it would let one slow tracking host freeze the countdown and the
   * skip control. Macros are substituted here rather than where each beacon is
   * created, because the values they need belong to the session — and doing it
   * in one place is what stops a `[ERRORCODE]` going out as literal text.
   */
  private send(beacons: readonly VastBeacon[], slot: Slot | null, ad: VastAd | null = slot?.ad ?? null): void {
    if (beacons.length === 0) return
    this.notifyMeasurement(beacons, slot)
    this.notifyListener(beacons, ad)
    const expanded = beacons.map((beacon) => this.expandMacros(beacon, slot, ad))
    this.environment.transport.fire(expanded).catch(() => undefined)
  }

  /**
   * Measurement is driven from the beacons rather than from separate call sites,
   * so what a vendor observes is the same sequence, in the same order, that the
   * ad server is told about.
   */
  private notifyMeasurement(beacons: readonly VastBeacon[], slot: Slot | null): void {
    const measurement = this.measurement
    if (!measurement) return
    let last: string | null = null
    for (const beacon of beacons) {
      const event = measurementEvent(beacon.kind, this.lastTick?.isMuted ?? false, slot?.engine.duration ?? 0)
      // One `<Impression>` element per vendor is normal; one impression is what happened.
      const key = event ? JSON.stringify(event) : null
      if (!event || key === last) continue
      last = key
      measurement.record(event)
    }
  }

  /** The listener hears the same sequence, in the same order, for the same reason measurement does. */
  private notifyListener(beacons: readonly VastBeacon[], ad: VastAd | null): void {
    let last: string | null = null
    for (const beacon of beacons) {
      // Three `<Impression>` URLs are three beacons and one impression.
      const key = JSON.stringify(beacon.kind)
      if (key === last) continue
      last = key
      this.emit('reported', beacon.kind, ad)
    }
  }

  private expandMacros(beacon: VastBeacon, slot: Slot | null, ad: VastAd | null): VastBeacon {
    const kind = beacon.kind
    const host = this.configuration.macroValues
    const context: VastMacroContext = {
      // Only an error beacon carries a code, and it is the code for *this*
      // failure. `[REASON]` works the same way.
      errorCode: kind.type === 'error' ? kind.error : null,
      verificationNotExecutedReason: kind.type === 'verificationNotExecuted' ? kind.reason : null,
      adPlayhead: this.lastTick?.adTime ?? null,
      contentPlayhead: this.content?.currentTime ?? null,
      assetUri: slot?.mediaFile.url ?? null,
      playerSize: this.containerPixels(),
      isMuted: this.lastTick?.isMuted ?? null,
      isFullscreen: this.isFullscreen(),
      verificationVendors: ad?.adVerifications.map((v) => v.vendor).filter((v): v is string => v !== null) ?? [],
      omidPartner: this.measurement?.omidPartner ?? null,
      host: {
        ...host,
        deviceUserAgent: host.deviceUserAgent ?? this.environment.userAgent,
        breakPosition: host.breakPosition ?? breakPositionCode(this.breakPosition),
      },
      pageUrl: this.environment.pageUrl,
      mediaMimeType: slot?.mediaFile.mimeType ?? null,
      transactionId: this.transactionId,
      executesOmid: this.measurement !== null,
    }
    return { ...beacon, url: this.macros.expandUrl(beacon.url, context) }
  }

  private isFullscreen(): boolean | null {
    if (typeof document === 'undefined') return null
    const element = document.fullscreenElement
    return element ? element === this.adPlayer.container || element.contains(this.adPlayer.container) : false
  }

  // MARK: - Publishing

  private setState(state: VastAdState): void {
    this.state = state
    this.publish()
  }

  private resetPublishedAd(): void {
    this.currentAd = null
    this.canSkip = false
    this.timeUntilSkip = null
    this.remainingTime = 0
    this.lastTick = null
  }

  private makeSnapshot(): VastAdSnapshot {
    return Object.freeze({
      state: this.state,
      currentAd: this.currentAd,
      adPosition: this.adPosition,
      remainingTime: this.remainingTime,
      canSkip: this.canSkip,
      timeUntilSkip: this.timeUntilSkip,
      isMuted: this.isMuted,
      mutedByAutoplayPolicy: this.mutedByAutoplayPolicy,
      pendingBreakCount: this.queue.length,
      // Between two breaks asked for together the state reads `finished`, but
      // the content is still held for the next one: no controls in the gap.
      permitsPlaybackControls: isOutsideBreak(this.state) && !this.contentPaused,
      suppressesAdUi: this.suppressesAdUi(),
      effectiveSkipPresentation: this.skipPresentation(),
    })
  }

  private publish(): void {
    const next = this.makeSnapshot()
    if (shallowEqual(next, this.snapshot)) return
    this.snapshot = next
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber()
      } catch (error) {
        VastLog.warning(`a subscriber threw: ${String(error)}`)
      }
    }
  }

  private emit<K extends keyof VastAdSessionEvents>(event: K, ...args: Parameters<VastAdSessionEvents[K]>): void {
    const set = this.handlers.get(event) as Set<(...a: Parameters<VastAdSessionEvents[K]>) => void> | undefined
    if (!set) return
    for (const handler of [...set]) {
      try {
        handler(...args)
      } catch (error) {
        // A host's handler failing must not take the break down with it.
        VastLog.warning(`a "${event}" handler threw: ${String(error)}`)
      }
    }
  }
}

/**
 * How long the playhead may sit still, while the element claims to be playing,
 * before the creative is written off as unplayable (402).
 */
const STALL_TIMEOUT_SECONDS = 10

/** Less than this between ticks is the playhead sitting still, not moving. */
const ADVANCE_EPSILON_SECONDS = 0.01

/**
 * How close to the end of a creative a stop stops being a pause: wider than
 * the engine's own completion margin and than one tick, so it holds whichever
 * of the end and the stop arrives first.
 */
const END_OF_CREATIVE_MARGIN_SECONDS = 0.5

/**
 * WCAG 2.2's minimum target size (2.5.8), in CSS pixels. The native SDKs use
 * their platforms' touch minimums; this is the web's.
 */
const MINIMUM_TARGET_PX = 24

function breakPositionCode(position: VastBreakPosition | null): number | null {
  switch (position) {
    case 'preroll':
      return 1
    case 'midroll':
      return 2
    case 'postroll':
      return 3
    default:
      return null
  }
}

function measurementEvent(kind: VastBeaconKind, isMuted: boolean, duration: number): VastMeasurementEvent | null {
  switch (kind.type) {
    case 'impression':
      return { type: 'impression' }
    case 'progress':
      return { type: 'progress', offset: kind.offset }
    case 'clickTracking':
    case 'customClick':
      return { type: 'clicked' }
    case 'error':
      return { type: 'failed', error: kind.error }
    // Both are only fired when nothing is measuring, so nobody is listening for them.
    case 'verificationNotExecuted':
    case 'viewUndetermined':
      return null
    case 'tracking':
      switch (kind.event) {
        case 'start':
          return { type: 'start', duration, isMuted }
        case 'firstQuartile':
        case 'midpoint':
        case 'thirdQuartile':
        case 'complete':
          return { type: 'quartile', event: kind.event }
        case 'pause':
          return { type: 'pause' }
        case 'resume':
          return { type: 'resume' }
        case 'skip':
          return { type: 'skipped' }
        default:
          return null
      }
  }
}

function shallowEqual(a: VastAdSnapshot, b: VastAdSnapshot): boolean {
  const keys = Object.keys(a) as (keyof VastAdSnapshot)[]
  return keys.every((key) => a[key] === b[key])
}

function defaultEnvironment(configuration: VastConfiguration): VastEnvironment {
  const doc = typeof document !== 'undefined' ? document : null
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : null
  let probe: HTMLVideoElement | null = null
  return {
    transport: configuration.transport ?? new VastFetchTransport(),
    loader: configuration.loader ?? new VastFetchLoader(configuration.requestCredentials),
    uptimeSeconds: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
    isPageVisible: () => doc?.visibilityState !== 'hidden',
    onVisibilityChange: (callback) => {
      if (!doc) return () => undefined
      doc.addEventListener('visibilitychange', callback)
      return () => doc.removeEventListener('visibilitychange', callback)
    },
    isTelevision: userAgent !== null && TELEVISION_AGENTS.test(userAgent),
    canPlayType: (mimeType) => {
      if (!doc) return true
      probe ??= doc.createElement('video')
      return probe.canPlayType(mimeType) !== ''
    },
    screenSize: () => {
      if (typeof screen === 'undefined') return null
      const ratio = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
      return { width: Math.round(screen.width * ratio), height: Math.round(screen.height * ratio) }
    },
    pageUrl: typeof location !== 'undefined' ? location.href : null,
    userAgent,
    nowPlayingTitle: vastStringsFor().nowPlayingTitle,
    randomId: () => {
      const cryptoApi = typeof crypto !== 'undefined' ? crypto : null
      if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
    },
  }
}

/** Smart-TV browsers, by the names they give themselves. */
const TELEVISION_AGENTS = /SMART-TV|SmartTV|Tizen|Web0S|webOS|NetCast|HbbTV|BRAVIA|AFT[A-Z]|CrKey|Android TV/i
