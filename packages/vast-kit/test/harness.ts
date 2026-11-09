import { vi } from 'vitest'
import type { VastAd, VastBeacon, VastBeaconKind, VastResourceLoader, VastTick } from '@kinodaran/vast-core'
import { VastAdSession, type VastEnvironment } from '../src/VastAdSession.js'
import type { VastAdOutcome, VastAdState, VastClock, VastConfiguration } from '../src/VastAdSessionTypes.js'
import type { VastBeaconTransport } from '../src/VastBeaconTransport.js'
import type { VastContentPlayer } from '../src/VastContentPlayer.js'
import { VastLog } from '../src/VastLog.js'
import type { VastMeasurement, VastMeasurementContext, VastMeasurementEvent } from '../src/VastMeasurement.js'

/**
 * A deterministic stage for `VastAdSession`: every input the session reads from
 * the page is a fake the test drives by hand — the network, the clock, page
 * visibility, uptime, and the ad `<video>` itself, whose media pipeline jsdom
 * does not implement.
 */

// The SDK's console voice is for hosts; in a test run it is noise.
VastLog.enabled = false

// Held before any test can install fake timers, which capture `setImmediate`
// by default: settling must still reach the end of the real task queue.
const realSetImmediate: typeof setImmediate = globalThis.setImmediate

export const TAG = 'https://ads.test/tag.xml'
export const PAGE_URL = 'https://www.example.com/watch?v=1'

// MARK: - VAST builders

export interface AdSpec {
  readonly id: string
  readonly sequence?: number
  /** `<Duration>`, as a timecode. */
  readonly duration?: string
  readonly skipOffset?: string
  readonly mimeType?: string
  readonly title?: string
  readonly clickThrough?: string
  /** Replaces the single default `<Impression>`. */
  readonly impressions?: readonly string[]
  /** `false` leaves `<Error>` out, as some real responses do. */
  readonly withError?: boolean
  /** Raw `<Extension>` elements. */
  readonly extensions?: string
  /** Raw `<AdVerifications>` block. */
  readonly verifications?: string
}

/** Every event the builders track, so any of them reaching the transport is visible. */
const TRACKED = [
  'loaded',
  'creativeView',
  'start',
  'firstQuartile',
  'midpoint',
  'thirdQuartile',
  'complete',
  'skip',
  'pause',
  'resume',
  'mute',
  'unmute',
] as const

export function mediaUrl(id: string): string {
  return `https://cdn.test/${id}.mp4`
}

export function errorUrl(id: string): string {
  return `https://ads.test/${id}/error?code=[ERRORCODE]`
}

/** One `<Ad>` with an `<InLine>` linear creative. */
export function ad(spec: AdSpec | string): string {
  const s: AdSpec = typeof spec === 'string' ? { id: spec } : spec
  const id = s.id
  const sequence = s.sequence === undefined ? '' : ` sequence="${s.sequence}"`
  const skip = s.skipOffset === undefined ? '' : ` skipoffset="${s.skipOffset}"`
  const title = s.title === undefined ? '' : `<AdTitle>${s.title}</AdTitle>`
  const error = s.withError === false ? '' : `<Error><![CDATA[${errorUrl(id)}]]></Error>`
  const impressions = (s.impressions ?? [`https://ads.test/${id}/impression`])
    .map((url) => `<Impression><![CDATA[${url}]]></Impression>`)
    .join('')
  const tracking = TRACKED.map((event) => `<Tracking event="${event}"><![CDATA[https://ads.test/${id}/${event}]]></Tracking>`).join('')
  const clicks =
    s.clickThrough === undefined
      ? ''
      : `<VideoClicks><ClickThrough><![CDATA[${s.clickThrough}]]></ClickThrough>` +
        `<ClickTracking><![CDATA[https://ads.test/${id}/click]]></ClickTracking></VideoClicks>`
  const extensions = s.extensions === undefined ? '' : `<Extensions>${s.extensions}</Extensions>`
  return (
    `<Ad id="${id}"${sequence}><InLine>` +
    `<AdSystem>test</AdSystem>${title}${error}${impressions}` +
    `<Creatives><Creative><Linear${skip}>` +
    `<Duration>${s.duration ?? '00:00:10'}</Duration>` +
    `<TrackingEvents>${tracking}</TrackingEvents>${clicks}` +
    `<MediaFiles><MediaFile delivery="progressive" type="${s.mimeType ?? 'video/mp4'}" width="1280" height="720">` +
    `<![CDATA[${mediaUrl(id)}]]></MediaFile></MediaFiles>` +
    `</Linear></Creative></Creatives>${s.verifications ?? ''}${extensions}` +
    `</InLine></Ad>`
  )
}

/** A response holding one stand-alone InLine ad. */
export function inLine(spec: AdSpec | string): string {
  return `<VAST version="4.3">${ad(spec)}</VAST>`
}

/** A response holding several ads — sequenced ones form the pod, the rest are spares. */
export function response(...ads: readonly (AdSpec | string)[]): string {
  return `<VAST version="4.3">${ads.map(ad).join('')}</VAST>`
}

export interface WrapperSpec {
  readonly id: string
  readonly tagUri: string
  readonly allowMultipleAds?: boolean
}

export function wrapperErrorUrl(id: string): string {
  return `https://wrapper.test/${id}/error?code=[ERRORCODE]`
}

/** A Wrapper redirecting to `tagUri`, with its own `<Error>`, `<Impression>` and `start` tracker. */
export function wrapper(spec: WrapperSpec): string {
  const id = spec.id
  const multiple = spec.allowMultipleAds ? ' allowMultipleAds="true"' : ''
  return (
    `<VAST version="4.3"><Ad id="${id}"><Wrapper${multiple}>` +
    `<AdSystem>test</AdSystem>` +
    `<VASTAdTagURI><![CDATA[${spec.tagUri}]]></VASTAdTagURI>` +
    `<Error><![CDATA[${wrapperErrorUrl(id)}]]></Error>` +
    `<Impression><![CDATA[https://wrapper.test/${id}/impression]]></Impression>` +
    `<Creatives><Creative><Linear><TrackingEvents>` +
    `<Tracking event="start"><![CDATA[https://wrapper.test/${id}/start]]></Tracking>` +
    `</TrackingEvents></Linear></Creative></Creatives>` +
    `</Wrapper></Ad></VAST>`
  )
}

/** The no-fill response: a document with nothing but an `<Error>`. */
export function noAd(error = 'https://ads.test/no-ad?code=[ERRORCODE]'): string {
  return `<VAST version="4.3"><Error><![CDATA[${error}]]></Error></VAST>`
}

// MARK: - Network

/** Collects what the session hands over, already macro-expanded. Never fails. */
export class RecordingTransport implements VastBeaconTransport {
  readonly fired: VastBeacon[] = []

  fire(beacons: readonly VastBeacon[]): Promise<void> {
    this.fired.push(...beacons)
    return Promise.resolve()
  }

  get urls(): string[] {
    return this.fired.map((beacon) => beacon.url)
  }

  /** Expanded URLs whose path starts with `prefix`, e.g. `https://ads.test/a1/`. */
  urlsFor(prefix: string): string[] {
    return this.urls.filter((url) => url.startsWith(prefix))
  }

  clear(): void {
    this.fired.length = 0
  }
}

/**
 * Answers from a map. A URL it does not know fails like a dead host; a URL in
 * `hanging` never answers, and gives up only when the request is aborted — as
 * `fetch` does.
 */
export class MapLoader implements VastResourceLoader {
  readonly requests: string[] = []
  readonly aborted: string[] = []

  constructor(
    readonly documents: Record<string, string> = {},
    readonly hanging: Set<string> = new Set(),
  ) {}

  loadVast(url: string, _timeoutSeconds: number, signal?: AbortSignal): Promise<string> {
    this.requests.push(url)
    if (this.hanging.has(url)) {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => {
          this.aborted.push(url)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }
    const xml = this.documents[url]
    return xml === undefined ? Promise.reject(new TypeError(`unreachable: ${url}`)) : Promise.resolve(xml)
  }
}

// MARK: - Clock

/**
 * A `VastClock` the test pushes ticks into. Reused across a pod, as the
 * session expects of an injected clock, so `start` works again after `stop`.
 */
export class ScriptedClock implements VastClock {
  starts = 0
  stops = 0
  private onTick: ((tick: VastTick) => void) | null = null

  get running(): boolean {
    return this.onTick !== null
  }

  start(onTick: (tick: VastTick) => void): void {
    this.starts++
    this.onTick = onTick
  }

  stop(): void {
    this.stops++
    this.onTick = null
  }

  /** @returns whether anyone was listening. */
  push(tick: VastTick): boolean {
    const listener = this.onTick
    if (!listener) return false
    listener(tick)
    return true
  }
}

// MARK: - The ad element

export type AutoplayPolicy = 'allowed' | 'mutedOnly' | 'refused'

/** `MediaError.code` values. */
export const MEDIA_ERR = { ABORTED: 1, NETWORK: 2, DECODE: 3, SRC_NOT_SUPPORTED: 4 } as const

interface PendingPlay {
  resolve(): void
  reject(error: unknown): void
}

/**
 * The media pipeline of one `<video>`, scripted.
 *
 * jsdom has none, so `play`/`pause`/`load` and the read-only media state are
 * replaced on the element itself, and events are dispatched in the order a
 * browser produces them: `play` and the promise from `play()` are asynchronous
 * (queued here as microtasks), `loadeddata` precedes `playing`, reaching the end
 * fires `pause` with `ended` already true and then `ended`, and `load()` drops
 * every event still queued for the previous source and rejects pending
 * `play()` promises with `AbortError`.
 */
export class ScriptedMedia {
  paused = true
  currentTime = 0
  /** What `duration` reports once data has arrived. */
  mediaDuration = 10
  duration = Number.NaN
  readyState = 0
  ended = false
  seeking = false
  error: { readonly code: number } | null = null

  autoplay: AutoplayPolicy = 'allowed'
  /** Whether `play()` buffers and starts on its own; off, the test calls {@link startPlayback}. */
  autoStart = true
  /** Sources that fail to load, with the `MediaError.code` they raise. */
  readonly failures = new Map<string, number>()

  /** `load`, `play`, `play:refused`, `pause`, in call order. */
  readonly calls: string[] = []

  private generation = 0
  private loadedDataFired = false
  private pending: PendingPlay[] = []

  constructor(readonly video: HTMLVideoElement) {
    const define = (name: string, get: () => unknown, set?: (value: never) => void): void => {
      Object.defineProperty(video, name, { configurable: true, get, set })
    }
    define('paused', () => this.paused)
    define('duration', () => this.duration)
    define('readyState', () => this.readyState)
    define('ended', () => this.ended)
    define('seeking', () => this.seeking)
    define('error', () => this.error)
    define('currentSrc', () => (video.getAttribute('src') === null ? '' : video.src))
    define(
      'currentTime',
      () => this.currentTime,
      (value: number) => {
        this.currentTime = value
      },
    )
    video.play = () => this.play()
    video.pause = () => this.pause()
    video.load = () => this.load()
  }

  get source(): string | null {
    return this.video.getAttribute('src')
  }

  load(): void {
    this.calls.push('load')
    this.generation++
    this.rejectPending(new DOMException('The play() request was interrupted by a new load request.', 'AbortError'))
    this.paused = true
    this.ended = false
    this.currentTime = 0
    this.readyState = 0
    this.duration = Number.NaN
    this.error = null
    this.loadedDataFired = false
    const source = this.source
    const code = source === null ? undefined : this.failures.get(source)
    // Two tasks out: the failure is the network's answer, which comes after the
    // `play` event that a `play()` straight after `load()` queues.
    if (code !== undefined) this.queue(() => this.queue(() => this.raise(code)))
  }

  play(): Promise<void> {
    const refused = this.autoplay === 'refused' || (this.autoplay === 'mutedOnly' && !this.video.muted)
    if (refused) {
      this.calls.push('play:refused')
      return Promise.reject(new DOMException("play() failed because the user didn't interact with the document first.", 'NotAllowedError'))
    }
    this.calls.push('play')
    if (this.error !== null) return Promise.reject(new DOMException('no supported source', 'NotSupportedError'))
    if (this.ended) {
      this.ended = false
      this.currentTime = 0
    }
    const wasPaused = this.paused
    this.paused = false
    const promise = new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }))
    this.queue(() => {
      if (wasPaused) this.dispatch('play')
      if (this.readyState >= 3) this.notifyPlaying()
      else if (this.autoStart && this.source !== null && !this.failures.has(this.source)) this.startPlayback()
    })
    return promise
  }

  pause(): void {
    this.calls.push('pause')
    if (this.paused) return
    this.paused = true
    this.rejectPending(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'))
    this.queue(() => this.dispatch('pause'))
  }

  // MARK: Scripted pipeline

  /** Data arrives: `loadeddata` (once per source), then `playing` if playback was asked for. */
  startPlayback(): void {
    this.readyState = 4
    this.duration = this.mediaDuration
    if (!this.loadedDataFired) {
      this.loadedDataFired = true
      this.dispatch('loadeddata')
    }
    if (!this.paused) this.notifyPlaying()
  }

  /** The creative plays out: `pause` with `ended` already true, then `ended`. */
  reachEnd(): void {
    this.currentTime = this.duration
    this.ended = true
    const wasPlaying = !this.paused
    this.paused = true
    if (wasPlaying) this.dispatch('pause')
    this.dispatch('ended')
  }

  /** Something other than the session stops the element — a headset, the OS media hub. */
  externalPause(): void {
    this.pause()
  }

  /** A `MediaError` now, as a network or decode failure mid-stream raises one. */
  fail(code: number): void {
    this.raise(code)
  }

  private raise(code: number): void {
    this.error = { code }
    this.rejectPending(new DOMException('Failed to load because no supported source was found.', 'NotSupportedError'))
    this.dispatch('error')
  }

  private notifyPlaying(): void {
    this.dispatch('playing')
    const pending = this.pending
    this.pending = []
    for (const play of pending) play.resolve()
  }

  private rejectPending(error: unknown): void {
    const pending = this.pending
    this.pending = []
    for (const play of pending) play.reject(error)
  }

  /** A media element task: dropped if the element has been reloaded by the time it runs. */
  private queue(task: () => void): void {
    const generation = this.generation
    void Promise.resolve().then(() => {
      if (generation === this.generation) task()
    })
  }

  private dispatch(name: string): void {
    this.video.dispatchEvent(new Event(name))
  }
}

// MARK: - Host-side fakes

/** Records what the session asks of the content. */
export class FakeContent implements VastContentPlayer {
  readonly calls: string[] = []
  volume = 1
  muted = false
  currentTime = 42

  pauseForBreak(): void {
    this.calls.push('pause')
  }

  resumeAfterBreak(): void {
    this.calls.push('resume')
  }
}

export class FakeMeasurement implements VastMeasurement {
  readonly recorded: string[] = []
  readonly contexts: VastMeasurementContext[] = []
  readonly omidPartner = 'Kinodaran/1.0'

  begin(context: VastMeasurementContext): void {
    this.contexts.push(context)
    this.recorded.push(`begin ${context.ad.id}`)
  }

  record(event: VastMeasurementEvent): void {
    this.recorded.push(measurementLabel(event))
  }

  finish(): void {
    this.recorded.push('finish')
  }
}

function measurementLabel(event: VastMeasurementEvent): string {
  switch (event.type) {
    case 'quartile':
      return `quartile ${event.event}`
    case 'progress':
      return `progress ${event.offset}`
    case 'failed':
      return `failed ${event.error}`
    case 'start':
      return `start ${event.duration}${event.isMuted ? ' muted' : ''}`
    default:
      return event.type
  }
}

/** `navigator.mediaSession`, as far as the session touches it. */
export class FakeMediaSession {
  metadata: unknown = null
  readonly handlers = new Map<string, ((details?: unknown) => void) | null>()

  setActionHandler(action: string, handler: ((details?: unknown) => void) | null): void {
    this.handlers.set(action, handler)
  }

  invoke(action: string): void {
    const handler = this.handlers.get(action)
    if (!handler) throw new Error(`no handler for ${action}`)
    handler()
  }
}

// MARK: - Labels

export function kindLabel(kind: VastBeaconKind): string {
  switch (kind.type) {
    case 'impression':
      return 'impression'
    case 'tracking':
      return kind.event
    case 'progress':
      return `progress ${kind.offset}`
    case 'clickTracking':
      return 'clickTracking'
    case 'error':
      return `error ${kind.error}`
    case 'verificationNotExecuted':
      return `verificationNotExecuted ${kind.reason}`
    case 'viewUndetermined':
      return 'viewUndetermined'
    case 'customClick':
      return 'customClick'
  }
}

export function outcomeLabel(outcome: VastAdOutcome): string {
  return outcome.type === 'failed' ? `failed ${outcome.error}` : outcome.type
}

export function stateLabel(state: VastAdState): string {
  return state.type === 'finished' ? `finished ${outcomeLabel(state.outcome)}` : state.type
}

// MARK: - The harness

export interface HarnessOptions {
  readonly documents?: Readonly<Record<string, string>>
  /** URLs whose request never answers until aborted. */
  readonly hanging?: readonly string[]
  readonly configuration?: Partial<VastConfiguration>
  readonly environment?: Partial<VastEnvironment>
  /** `null` runs the session with no content player. */
  readonly content?: FakeContent | null
  readonly autoplay?: AutoplayPolicy
  readonly autoStart?: boolean
  readonly pageVisible?: boolean
  /** Installed as `navigator.mediaSession` while the session is built. */
  readonly mediaSession?: FakeMediaSession
  readonly measurement?: VastMeasurement
}

const live: Harness[] = []

/** Destroys every session built since the last call; for `afterEach`. */
export function disposeHarnesses(): void {
  for (const harness of live.splice(0)) harness.dispose()
}

/**
 * Fake timers that leave `setImmediate` and microtasks real, so {@link Harness.settle}
 * keeps working while a test steps a timeout.
 */
export function useFakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
}

export class Harness {
  readonly container: HTMLDivElement
  readonly transport = new RecordingTransport()
  readonly loader: MapLoader
  readonly clock = new ScriptedClock()
  readonly content: FakeContent | null
  readonly session: VastAdSession
  readonly ad: ScriptedMedia

  /** Seconds, shared by tick `wallClock` and the session's uptime so playback and the stall watchdog agree. */
  now = 1000
  pageVisible: boolean
  randomIds = 0

  // What the session said, in order.
  readonly events: string[] = []
  readonly reported: string[] = []
  readonly reportedFor: Array<{ label: string; adId: string | null }> = []
  readonly states: string[] = []
  readonly progress: number[] = []
  readonly unavailable: string[] = []
  readonly skipAvailable: string[] = []

  private visibilityListener: (() => void) | null = null
  private visibilityStops = 0

  constructor(options: HarnessOptions = {}) {
    this.container = document.createElement('div')
    document.body.appendChild(this.container)
    this.loader = new MapLoader({ ...options.documents }, new Set(options.hanging ?? []))
    this.content = options.content === undefined ? new FakeContent() : options.content
    this.pageVisible = options.pageVisible ?? true

    const environment: Partial<VastEnvironment> = {
      transport: this.transport,
      loader: this.loader,
      uptimeSeconds: () => this.now,
      isPageVisible: () => this.pageVisible,
      onVisibilityChange: (callback) => {
        this.visibilityListener = callback
        return () => {
          this.visibilityStops++
          this.visibilityListener = null
        }
      },
      isTelevision: false,
      canPlayType: () => true,
      screenSize: () => ({ width: 1280, height: 720 }),
      pageUrl: PAGE_URL,
      userAgent: 'VastTest/1.0',
      nowPlayingTitle: 'Advertisement',
      randomId: () => `txn-${++this.randomIds}`,
      ...options.environment,
    }

    if (options.mediaSession) {
      Object.defineProperty(navigator, 'mediaSession', { value: options.mediaSession, configurable: true })
    }
    try {
      this.session = new VastAdSession({
        container: this.container,
        content: this.content,
        configuration: { mediaLoadTimeoutSeconds: 0, clock: this.clock, ...options.configuration },
        environment,
      })
    } finally {
      // The lock keeps the reference it was given; nothing else should see the stub.
      if (options.mediaSession) Reflect.deleteProperty(navigator, 'mediaSession')
    }
    if (options.measurement) this.session.measurement = options.measurement

    this.ad = new ScriptedMedia(this.session.adPlayer.video)
    this.ad.autoplay = options.autoplay ?? 'allowed'
    this.ad.autoStart = options.autoStart ?? true
    this.record()
    live.push(this)
  }

  get snapshot() {
    return this.session.getSnapshot()
  }

  get visibilityObserved(): boolean {
    return this.visibilityListener !== null
  }

  get visibilityStopCount(): number {
    return this.visibilityStops
  }

  /** Lets resolution, planning, loading and the element's queued events run to rest. */
  async settle(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      await new Promise<void>((resolve) => realSetImmediate(resolve))
    }
  }

  /** Moves wall clock and uptime together. */
  advance(seconds: number): void {
    this.now += seconds
  }

  /** One observation of the playhead at the current wall clock. @returns whether the session was listening. */
  tick(
    adTime: number,
    options: { rate?: number; duration?: number | null; isMuted?: boolean; itemIsOurs?: boolean } = {},
  ): boolean {
    this.ad.currentTime = adTime
    return this.clock.push({
      adTime,
      duration: options.duration === undefined ? null : options.duration,
      rate: options.rate ?? 1,
      wallClock: this.now,
      itemIsOurs: options.itemIsOurs ?? true,
      isMuted: options.isMuted ?? false,
    })
  }

  /** Natural playback from `from` to `to`: wall clock advances exactly as far as the playhead. */
  play(from: number, to: number, step = 1): void {
    this.tick(from)
    const count = Math.round((to - from) / step)
    for (let i = 1; i <= count; i++) {
      this.advance(step)
      this.tick(from + i * step)
    }
  }

  /** The playhead held still at `at` while wall clock and uptime run on — buffering, or a hold. */
  stuck(at: number, seconds: number, step = 1): void {
    const count = Math.round(seconds / step)
    for (let i = 1; i <= count; i++) {
      this.advance(step)
      this.tick(at, { rate: 0 })
    }
  }

  setPageVisible(visible: boolean): void {
    this.pageVisible = visible
    this.visibilityListener?.()
  }

  /** Plays the creative on screen to its end and lets the session move on. */
  async finishAd(duration = 10): Promise<void> {
    this.play(0, duration)
    this.ad.reachEnd()
    await this.settle()
  }

  dispose(): void {
    this.session.destroy()
    this.container.remove()
  }

  private record(): void {
    const s = this.session
    s.on('adStarted', (ad, position) => this.events.push(`started ${ad.id} ${position.index}/${position.total}`))
    s.on('adFinished', (ad, outcome) => this.events.push(`finished ${ad.id} ${outcomeLabel(outcome)}`))
    s.on('adFailed', (error, ad) => this.events.push(`failed ${ad?.id ?? null} ${error}`))
    s.on('allAdsFinished', () => this.events.push('all finished'))
    s.on('skipAvailable', (ad: VastAd) => this.skipAvailable.push(ad.id))
    s.on('skipControlUnavailable', (_ad, reason) => this.unavailable.push(reason))
    s.on('adProgress', (_ad, time) => this.progress.push(time))
    s.on('reported', (kind, ad) => {
      const label = kindLabel(kind)
      this.reported.push(label)
      this.reportedFor.push({ label, adId: ad?.id ?? null })
    })
    s.subscribe(() => {
      const label = stateLabel(s.getSnapshot().state)
      if (this.states[this.states.length - 1] !== label) this.states.push(label)
    })
  }
}

export function harness(options: HarnessOptions = {}): Harness {
  return new Harness(options)
}

/** The value of one query parameter of an expanded URL. */
export function param(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name)
}

/** The raw (still-encoded) value of one query parameter, for checking how a macro was encoded. */
export function rawParam(url: string, name: string): string | null {
  const query = url.split('?')[1] ?? ''
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=')
    if (at > 0 && pair.substring(0, at) === name) return pair.substring(at + 1)
  }
  return null
}
