import { describe, expect, it } from 'vitest'
import { createAd, createLinear } from '../src/VastAd.js'
import type { VastAd } from '../src/VastAd.js'
import { VastError } from '../src/VastError.js'
import type { VastTick } from '../src/VastTick.js'
import { VastTrackingEngine } from '../src/VastTrackingEngine.js'
import { label } from './support.js'

/**
 * The engine is pure, so every rule below is exercised with a scripted tick
 * sequence — no player, no media file, no real elapsed time.
 */
describe('VastTrackingEngine', () => {
  // MARK: - Fixtures

  const url = (path: string) => `https://ads.test/${path}`

  /** 30 second ad, skippable at 5s, full quartile set plus a 15s progress beacon. */
  const makeAd = (duration = 30.0): VastAd =>
    createAd({
      id: 'ad-1',
      linear: createLinear({
        duration,
        skipOffset: { type: 'time', seconds: 5.0 },
        trackingEvents: {
          start: [url('start')],
          firstQuartile: [url('q1')],
          midpoint: [url('q2')],
          thirdQuartile: [url('q3')],
          complete: [url('complete')],
          skip: [url('skip')],
        },
        progressEvents: [{ offset: { type: 'time', seconds: 15.0 }, url: url('p15') }],
      }),
      impressions: [url('impression')],
      errors: [url('error')],
    })

  const tick = (time: number, wall: number, rate = 1, ours = true): VastTick => ({
    adTime: time,
    duration: 30.0,
    rate,
    wallClock: wall,
    itemIsOurs: ours,
  })

  /** Runs a tick sequence and returns the events that fired, in order. */
  const play = (engine: VastTrackingEngine, ticks: readonly (readonly [number, number])[]): string[] =>
    ticks.reduce<string[]>((events, [time, wall]) => events.concat(engine.advance(tick(time, wall)).map(label)), [])

  const seconds = (through: number): [number, number][] =>
    Array.from({ length: through + 1 }, (_, second) => [second, second])

  /** Kotlin's `assertEquals(expected, actual, absoluteTolerance)`: `|expected - actual| <= tolerance`. */
  const expectClose = (actual: number, expected: number, tolerance: number, message?: string) => {
    expect(Math.abs(expected - actual), message ?? `expected ${actual} to be within ${tolerance} of ${expected}`).toBeLessThanOrEqual(
      tolerance,
    )
  }

  const count = (events: readonly string[], name: string) => events.filter((event) => event === name).length

  // MARK: - Normal playback

  it('uninterruptedPlaybackFiresEveryEventOnce', () => {
    const engine = new VastTrackingEngine(makeAd())
    const events = play(engine, seconds(30))

    expect(events).toEqual(['impression', 'start', 'firstQuartile', 'midpoint', 'p15', 'thirdQuartile', 'complete'])
    expectClose(engine.watched, 30.0, 0.01)
  })

  it('impressionFiresOnceEvenAcrossManyTicks', () => {
    const events = play(new VastTrackingEngine(makeAd()), seconds(3))

    expect(count(events, 'impression')).toBe(1)
    expect(count(events, 'start')).toBe(1)
  })

  // MARK: - Seeking

  /**
   * VAST 4.3 §3.14.1 defines a quartile as the creative having "played
   * continuously ... at normal speed", so skipping ahead must not earn one.
   */
  it('forwardSeekDoesNotEarnQuartiles', () => {
    const engine = new VastTrackingEngine(makeAd())
    const events = play(engine, [[0, 0], [1, 1], [2, 2], [28, 3], [29, 4]])

    expect(events).toEqual(['impression', 'start'])
    expectClose(engine.watched, 2.0, 0.01)
  })

  /**
   * Regression: the tick immediately after a seek looks like ordinary playback,
   * so a mark anchored on the raw playhead let the skipped span back in and
   * unlocked every quartile. Coverage stays where the viewer left off.
   */
  it('tickAfterForwardSeekDoesNotReadmitSkippedTime', () => {
    const engine = new VastTrackingEngine(makeAd())
    play(engine, [[0, 0], [1, 1], [2, 2], [28, 3], [29, 4], [30, 5]])

    expectClose(engine.watched, 2.0, 0.01)
  })

  it('rewindDoesNotRefireAlreadyEarnedQuartiles', () => {
    const engine = new VastTrackingEngine(makeAd())
    const events = play(engine, [[0, 0], [8, 8], [16, 16], [2, 17], [3, 18], [4, 19]])

    expect(count(events, 'firstQuartile')).toBe(1)
    expect(count(events, 'midpoint')).toBe(1)
    // Coverage peaked at 16s; rewinding and replaying does not extend it.
    expectClose(engine.watched, 16.0, 0.01)
  })

  // MARK: - Player state

  it('pausedTicksDoNotAccumulateWatchedTime', () => {
    const engine = new VastTrackingEngine(makeAd())
    engine.advance(tick(0, 0))
    engine.advance(tick(4, 4))
    // Paused for ten wall-clock seconds; the playhead does not move.
    engine.advance(tick(4, 14, 0))
    engine.advance(tick(5, 15))

    expectClose(engine.watched, 5.0, 0.01, 'the pause cost no coverage')
  })

  /** The host swapping the player's item out means nothing afterwards can be attributed to this creative. */
  it('foreignPlayerItemEndsSessionWithDisplayError', () => {
    const engine = new VastTrackingEngine(makeAd())
    engine.advance(tick(0, 0))
    engine.advance(tick(4, 4))
    const beacons = engine.advance(tick(5, 5, 1, false))

    expect(beacons.map(label)).toEqual(['error 405'])
    expect(engine.isFinished).toBe(true)
    expect(engine.advance(tick(6, 6)), 'a finished session emits nothing further').toEqual([])
  })

  // MARK: - Skip

  /**
   * §3.14.1: a `progress` offset the viewer already earned still counts when the
   * ad is skipped after it — that is what makes a skipped view billable.
   */
  it('skipAfterProgressOffsetStillFiresThatProgressBeacon', () => {
    const engine = new VastTrackingEngine(makeAd())
    play(engine, seconds(16))

    expect(engine.userDidSkip().map(label), 'p15 already fired during playback').toEqual(['skip'])
    expect(engine.isFinished).toBe(true)
  })

  it('skipBeforeProgressOffsetDoesNotFireIt', () => {
    const engine = new VastTrackingEngine(makeAd())
    play(engine, seconds(2))

    expect(engine.userDidSkip().map(label)).toEqual(['skip'])
  })

  it('skipAfterFinishEmitsNothing', () => {
    const engine = new VastTrackingEngine(makeAd())
    play(engine, seconds(30))

    expect(engine.userDidSkip()).toEqual([])
  })

  // MARK: - Errors

  it('failureFiresEveryErrorUriInTheChain', () => {
    const ad = createAd({
      id: 'ad-1',
      linear: createLinear({ duration: 30.0 }),
      errors: [url('wrapper-1-error'), url('wrapper-2-error'), url('inline-error')],
    })
    const beacons = new VastTrackingEngine(ad).fail(VastError.NO_SUPPORTED_MEDIA_FILE)

    expect(beacons.length, '§2.3.5.1 requires every wrapper in the chain to be told').toBe(3)
    expect(new Set(beacons.map(label))).toEqual(new Set(['error 403']))
  })

  // MARK: - Duration

  it('zeroDurationNeverFiresQuartiles', () => {
    const events = play(new VastTrackingEngine(makeAd(0.0), 0.0), seconds(2))

    expect(events).not.toContain('firstQuartile')
  })

  /** `<Duration>` is advisory; the player's real duration wins when supplied. */
  it('playerDurationOverridesDeclaredDuration', () => {
    const events = play(new VastTrackingEngine(makeAd(30.0), 8.0), [[0, 0], [2, 2], [4, 4]])

    expect(events).toContain('firstQuartile')
    expect(events).toContain('midpoint')
  })

  // MARK: - End of playback

  /**
   * Buffering does not skip any of the creative, so it must not stand between
   * the viewer and `complete`.
   */
  it('stallDoesNotPreventCompletion', () => {
    const engine = new VastTrackingEngine(makeAd())
    const events: string[] = []

    events.push(...engine.advance(tick(0, 0)).map(label))
    for (let second = 1; second <= 10; second++) events.push(...engine.advance(tick(second, second)).map(label))
    events.push(...engine.advance(tick(10, 18)).map(label)) // stalled 8s
    for (let second = 11; second <= 30; second++) events.push(...engine.advance(tick(second, second + 8.0)).map(label))

    expectClose(engine.watched, 30.0, 0.01, 'the stall cost no coverage')
    expect(events).toContain('complete')
  })

  /**
   * Real media routinely runs a little short of its declared `<Duration>`, so
   * coverage alone may never cross the threshold. The player's end-of-item
   * signal is what ends the ad in that case.
   */
  it('shortMediaEndsOnEndOfItemRatherThanHanging', () => {
    const engine = new VastTrackingEngine(makeAd(30.0), 30.0)
    // The file actually runs 26s, so coverage stops well short of 29.1.
    engine.advance(tick(0, 0))
    for (let second = 1; second <= 26; second++) engine.advance(tick(second, second))
    expect(engine.isFinished, 'coverage cannot reach a threshold the media never allows').toBe(false)

    const beacons = engine.playbackDidReachEnd().map(label)
    expect(engine.isFinished).toBe(true)
    expect(beacons, '26 of a declared 30 seconds is not 100% of the creative').not.toContain('complete')
  })

  /**
   * Reaching the end is not the same as having watched it: seeking to the end
   * must not earn `complete` (§3.14.1 "played to the end at normal speed").
   */
  it('seekingToTheEndDoesNotEarnComplete', () => {
    const engine = new VastTrackingEngine(makeAd())
    engine.advance(tick(0, 0))
    engine.advance(tick(1, 1))
    engine.advance(tick(29, 2)) // jump

    expect(engine.playbackDidReachEnd().map(label)).not.toContain('complete')
    expect(engine.isFinished, 'the session still ends').toBe(true)
  })

  it('endOfItemIsIgnoredAfterTheSessionAlreadyFinished', () => {
    const engine = new VastTrackingEngine(makeAd())
    play(engine, seconds(30))

    expect(engine.isFinished).toBe(true)
    expect(engine.playbackDidReachEnd(), 'complete must not fire twice').toEqual([])
  })

  /**
   * `<Duration>` is advisory and routinely disagrees with the real media by a
   * fraction of a second; the player's figure replaces it.
   */
  it('reportedDurationReplacesTheDeclaredOne', () => {
    const engine = new VastTrackingEngine(makeAd(24.0))
    engine.advance({ adTime: 0, duration: 24.04, rate: 1, wallClock: 0 })
    expectClose(engine.duration, 24.04, 0.001)
  })

  // MARK: - The end of the creative

  /**
   * What the engine cuts off the end of a creative is bounded by one tick, not by
   * a fraction of the running time.
   */
  it('theCutAtTheEndIsWithinOneTickWhateverTheDuration', () => {
    const interval = 0.2

    for (const duration of [10.0, 30.0, 60.0]) {
      const engine = new VastTrackingEngine(makeAd(duration), duration)
      let completedAt: number | null = null
      let time = 0.0

      while (time <= duration && completedAt === null) {
        const fired = engine.advance({ adTime: time, duration, rate: 1, wallClock: time })
        if (fired.some((beacon) => label(beacon) === 'complete')) completedAt = time
        time += interval
      }

      expect(completedAt, `a ${Math.trunc(duration)}s creative never completed`).not.toBeNull()
      expect(
        duration - completedAt! <= interval + 0.001,
        `a ${Math.trunc(duration)}s creative lost more than one tick of its ending`,
      ).toBe(true)
    }
  })

  /**
   * A creative that stalls *after* being watched through is finished, not
   * broken. Reporting 402 for its last frames would tell the ad server that a
   * delivered impression had failed.
   */
  it('aStallPastTheWatchedThresholdCompletesRatherThanFailing', () => {
    const engine = new VastTrackingEngine(makeAd(30.0), 30.0)
    engine.advance(tick(0, 0))
    for (let second = 1; second <= 29; second++) engine.advance(tick(second, second))
    // Past `COMPLETION_THRESHOLD`, short of the margin the engine finishes on.
    engine.advance(tick(29.5, 29.5))
    expect(engine.isFinished).toBe(false)

    const beacons = engine.playbackDidStall().map(label)
    expect(beacons, '29.5 of 30 seconds is a watched creative').toContain('complete')
    expect(beacons).not.toContain('error 402')
    expect(engine.isFinished).toBe(true)
  })

  /** A creative that never advances is written off, and the error goes to every URI in the chain. */
  it('stallReportsMediaTimeout', () => {
    const engine = new VastTrackingEngine(makeAd())
    engine.advance(tick(0, 0))

    expect(engine.playbackDidStall().map(label)).toEqual(['error 402'])
    expect(engine.isFinished).toBe(true)
  })

  it('aShortCreativeCannotSelfCompleteBeforeItsWatchedThreshold', () => {
    const engine = new VastTrackingEngine(makeAd(2.0), 2.0)
    for (let step = 0; step <= 9; step++) {
      const time = step * 0.2
      const fired = engine.advance({ adTime: time, duration: 2.0, rate: 1, wallClock: time })
      expect(
        fired.some((beacon) => label(beacon) === 'complete'),
        '1.8 seconds is below the 97% completion threshold',
      ).toBe(false)
    }
    const fired = engine.advance({ adTime: 1.96, duration: 2.0, rate: 1, wallClock: 1.96 })
    expect(fired.filter((beacon) => label(beacon) === 'complete').length).toBe(1)
    expect(engine.watched >= engine.duration * VastTrackingEngine.COMPLETION_THRESHOLD).toBe(true)
    expect(engine.playbackDidReachEnd()).toEqual([])
  })
})
