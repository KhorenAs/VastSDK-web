import { afterEach, describe, expect, it, vi } from 'vitest'
import { VastError } from '@kinodaran/vast-core'
import { VastSkipError, type VastBreakResult } from '../src/VastAdSessionTypes.js'
import { VastBeaconQueue, type VastKeyValueStorage } from '../src/VastBeaconQueue.js'
import { VastAdSession } from '../src/VastAdSession.js'
import { htmlVideoContent } from '../src/VastContentPlayer.js'
import { VastFetchLoader, VastFetchTransport } from '../src/VastHttp.js'
import {
  FakeContent,
  FakeMeasurement,
  FakeMediaSession,
  MEDIA_ERR,
  PAGE_URL,
  ScriptedMedia,
  TAG,
  disposeHarnesses,
  harness,
  inLine,
  mediaUrl,
  noAd,
  param,
  rawParam,
  response,
  useFakeTimers,
  wrapper,
  type Harness,
} from './harness.js'

const FULL_RUN = ['loaded', 'impression', 'creativeView', 'start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete']

const UI_HIDDEN = '<Extension type="uiSettings"><UiHidden>1</UiHidden></Extension>'

const VERIFICATION = `
  <AdVerifications>
    <Verification vendor="measure.test-omid">
      <JavaScriptResource apiFramework="omid" browserOptional="true"><![CDATA[https://measure.test/omid.js]]></JavaScriptResource>
      <TrackingEvents>
        <Tracking event="verificationNotExecuted"><![CDATA[https://measure.test/not-executed?reason=[REASON]]]></Tracking>
      </TrackingEvents>
    </Verification>
  </AdVerifications>`

function skipError(action: () => void): VastSkipError {
  try {
    action()
  } catch (error) {
    if (error instanceof VastSkipError) return error
    throw error
  }
  throw new Error('skip() did not refuse')
}

/**
 * Starts a pre-roll for `TAG` and lets it reach the first frame. The break's
 * promise comes back boxed: returned bare from an async function it would be
 * awaited, and the break only ends when the test plays it out.
 */
async function startPreroll(h: Harness): Promise<{ done: Promise<VastBreakResult> }> {
  const done = h.session.playBreak(TAG, { position: 'preroll' })
  await h.settle()
  return { done }
}

describe('VastAdSession', () => {
  afterEach(() => {
    disposeHarnesses()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // MARK: - Playing through

  describe('a pre-roll played through', () => {
    it('pauses the content at once, reports every beacon in order, and resumes the content once', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      const done = h.session.playBreak(TAG, { position: 'preroll' })

      // A pre-roll holds the content from the moment it is asked for.
      expect(h.content!.calls).toEqual(['pause'])
      expect(h.snapshot.state).toEqual({ type: 'loading' })
      expect(h.snapshot.permitsPlaybackControls).toBe(false)

      await h.settle()
      expect(h.snapshot.state).toEqual({ type: 'playing' })
      expect(h.snapshot.currentAd?.id).toBe('a1')
      expect(h.snapshot.adPosition).toEqual({ index: 1, total: 1 })
      expect(h.snapshot.remainingTime, 'seeded from <Duration> before the first tick').toBe(10)
      expect(h.session.adPlayer.layer.style.display).toBe('block')
      expect(h.ad.source).toBe(mediaUrl('a1'))
      expect(h.reported, '`loaded` is the element having data, before any tick').toEqual(['loaded'])

      await h.finishAd()
      const result = await done

      expect(h.reported).toEqual(FULL_RUN)
      expect(h.transport.urls).toEqual(FULL_RUN.map((event) => `https://ads.test/a1/${event}`))
      expect(h.events).toEqual(['started a1 1/1', 'finished a1 completed', 'all finished'])
      expect(h.states).toEqual(['idle', 'loading', 'playing', 'finished completed'])
      expect(h.content!.calls).toEqual(['pause', 'resume'])
      expect(result).toEqual({ outcome: { type: 'completed' }, adsStarted: 1 })

      expect(h.snapshot.currentAd).toBeNull()
      expect(h.snapshot.permitsPlaybackControls).toBe(true)
      expect(h.session.adPlayer.layer.style.display).toBe('none')
      expect(h.ad.source, 'the element let go of the creative').toBeNull()
    })

    it('publishes one frozen snapshot, the same object until something changes', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      const before = h.session.getSnapshot()
      expect(h.session.getSnapshot()).toBe(before)
      expect(Object.isFrozen(before)).toBe(true)

      await startPreroll(h)
      expect(h.session.getSnapshot()).not.toBe(before)
    })

    it('fires each quartile on the first tick that reaches it, and publishes progress', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      await startPreroll(h)

      h.play(0, 2)
      expect(h.reported).toEqual(['loaded', 'impression', 'creativeView', 'start'])
      h.advance(1)
      h.tick(3)
      expect(h.reported[h.reported.length - 1]).toBe('firstQuartile')
      expect(h.snapshot.remainingTime).toBe(7)
      expect(h.progress).toEqual([0, 1, 2, 3])
    })

    it('drives the built-in clock from the element when no clock is injected', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
      const h = harness({ documents: { [TAG]: inLine('a1') }, configuration: { clock: null } })
      const done = h.session.playBreak(TAG, { position: 'preroll' })
      await h.settle()

      for (let step = 1; step <= 50; step++) {
        h.ad.currentTime = step * 0.2
        await vi.advanceTimersByTimeAsync(200)
      }
      h.ad.reachEnd()
      await h.settle()
      const result = await done

      expect(h.reported).toEqual(FULL_RUN)
      expect(result.outcome).toEqual({ type: 'completed' })
    })

    it('reports nothing billable for a forward jump the wall clock cannot account for', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      await startPreroll(h)

      h.play(0, 1)
      h.advance(0.2)
      h.tick(9)

      expect(h.reported).not.toContain('firstQuartile')
      expect(h.reported).not.toContain('complete')
    })
  })

  // MARK: - Skipping

  describe('skipping', () => {
    it('is refused before skipoffset and honoured after it', async () => {
      const h = harness({ documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:05' }) } })
      await startPreroll(h)
      expect(h.snapshot.timeUntilSkip).toBe(5)
      expect(h.snapshot.canSkip).toBe(false)

      h.play(0, 3)
      expect(h.snapshot.timeUntilSkip).toBe(2)
      const refusal = skipError(() => h.session.skip())
      expect(refusal.reason).toBe('notYetAvailable')
      expect(refusal.afterSeconds).toBe(2)
      expect(h.reported).not.toContain('skip')

      h.advance(1)
      h.tick(4)
      h.advance(1)
      h.tick(5)
      expect(h.snapshot.canSkip).toBe(true)
      expect(h.snapshot.timeUntilSkip).toBeNull()
      expect(h.skipAvailable).toEqual(['s1'])
    })

    it('ends the ad as skipped, without complete or pause, and returns to the content', async () => {
      const h = harness({ documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:05' }) } })
      const done = h.session.playBreak(TAG, { position: 'preroll' })
      await h.settle()
      h.play(0, 5)

      h.session.skip()
      await h.settle()
      const result = await done

      expect(h.reported).toContain('skip')
      expect(h.reported).not.toContain('complete')
      expect(h.reported, 'the element stopping for a skip is not a viewer pause').not.toContain('pause')
      expect(h.events).toEqual(['started s1 1/1', 'finished s1 skipped', 'all finished'])
      expect(h.states[h.states.length - 1]).toBe('finished skipped')
      expect(result).toEqual({ outcome: { type: 'skipped' }, adsStarted: 1 })
      expect(h.content!.calls).toEqual(['pause', 'resume'])
    })

    it('says why it refuses when there is no ad or the ad is not skippable', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      expect(skipError(() => h.session.skip()).reason).toBe('noActiveAd')

      await startPreroll(h)
      h.play(0, 6)
      expect(skipError(() => h.session.skip()).reason).toBe('notSkippable')
    })
  })

  // MARK: - Pods

  describe('pods', () => {
    it('play in sequence order, as 1/2 then 2/2, with the content held between them', async () => {
      const h = harness({ documents: { [TAG]: response({ id: 'p2', sequence: 2 }, { id: 'p1', sequence: 1 }) } })
      const { done } = await startPreroll(h)

      expect(h.snapshot.currentAd?.id).toBe('p1')
      expect(h.snapshot.adPosition).toEqual({ index: 1, total: 2 })

      await h.finishAd()
      expect(h.snapshot.currentAd?.id).toBe('p2')
      expect(h.snapshot.adPosition).toEqual({ index: 2, total: 2 })
      expect(h.content!.calls, 'the content does not come back between pod members').toEqual(['pause'])

      await h.finishAd()
      const result = await done

      expect(h.events).toEqual([
        'started p1 1/2',
        'finished p1 completed',
        'started p2 2/2',
        'finished p2 completed',
        'all finished',
      ])
      expect(result).toEqual({ outcome: { type: 'completed' }, adsStarted: 2 })
      expect(h.transport.urls.filter((url) => url.endsWith('/impression'))).toEqual([
        'https://ads.test/p1/impression',
        'https://ads.test/p2/impression',
      ])
      expect(h.clock.starts, 'the injected clock is restarted for the second creative').toBe(2)
      expect(h.content!.calls).toEqual(['pause', 'resume'])
    })

    it('start each member with a clean skip state', async () => {
      const h = harness({
        documents: { [TAG]: response({ id: 'p1', sequence: 1, skipOffset: '00:00:02' }, { id: 'p2', sequence: 2 }) },
      })
      await startPreroll(h)
      h.play(0, 3)
      expect(h.snapshot.canSkip).toBe(true)
      h.session.skip()
      await h.settle()

      expect(h.snapshot.currentAd?.id).toBe('p2')
      expect(h.snapshot.canSkip).toBe(false)
      expect(h.snapshot.timeUntilSkip).toBeNull()
      expect(skipError(() => h.session.skip()).reason).toBe('notSkippable')
    })

    it('replace a member that fails before starting with a stand-alone ad in the same position', async () => {
      const h = harness({
        documents: { [TAG]: response({ id: 'p1', sequence: 1 }, { id: 'p2', sequence: 2 }, 'spare') },
      })
      h.ad.failures.set(mediaUrl('p1'), MEDIA_ERR.SRC_NOT_SUPPORTED)
      const { done } = await startPreroll(h)

      expect(h.snapshot.currentAd?.id).toBe('spare')
      expect(h.snapshot.adPosition, 'the badge a viewer reads stays true').toEqual({ index: 1, total: 2 })

      await h.finishAd()
      expect(h.snapshot.adPosition).toEqual({ index: 2, total: 2 })
      await h.finishAd()
      const result = await done

      expect(h.events).toEqual([
        'failed p1 401',
        'started spare 1/2',
        'finished spare completed',
        'started p2 2/2',
        'finished p2 completed',
        'all finished',
      ])
      expect(result.adsStarted).toBe(2)
    })
  })

  // MARK: - The response produced nothing

  describe('resolution failures', () => {
    it('tell a wrapper whose redirect is unreachable 301 and give the content back', async () => {
      const MISSING = 'https://ads.test/missing.xml'
      const h = harness({ documents: { [TAG]: wrapper({ id: 'w1', tagUri: MISSING }) } })
      const result = await h.session.playBreak(TAG, { position: 'preroll' })

      expect(h.loader.requests).toEqual([TAG, MISSING])
      expect(h.transport.urls).toEqual(['https://wrapper.test/w1/error?code=301'])
      expect(h.reported).toEqual(['error 301'])
      expect(h.events).toEqual(['failed null 301', 'all finished'])
      expect(h.content!.calls).toEqual(['pause', 'resume'])
      expect(h.snapshot.state).toEqual({ type: 'finished', outcome: { type: 'failed', error: VastError.WRAPPER_TIMEOUT } })
      expect(result).toEqual({ outcome: { type: 'failed', error: VastError.WRAPPER_TIMEOUT }, adsStarted: 0 })
    })

    it('report a no-fill response as 303 on its own <Error>', async () => {
      const h = harness({ documents: { [TAG]: noAd() } })
      const result = await h.session.playBreak(TAG, { position: 'preroll' })

      expect(h.transport.urls).toEqual(['https://ads.test/no-ad?code=303'])
      expect(h.events).toEqual(['failed null 303', 'all finished'])
      expect(result.outcome).toEqual({ type: 'failed', error: VastError.NO_VAST_RESPONSE_AFTER_WRAPPERS })
      expect(h.content!.calls).toEqual(['pause', 'resume'])
    })

    it('fail an unreachable tag with 301 and nobody to tell', async () => {
      const h = harness()
      const result = await h.session.playBreak(TAG, { position: 'preroll' })

      expect(h.transport.fired).toEqual([])
      expect(result.outcome).toEqual({ type: 'failed', error: VastError.WRAPPER_TIMEOUT })
      expect(h.content!.calls).toEqual(['pause', 'resume'])
    })

    it('fail a response that outlasts the resolution budget with 301, cancel it, and report nothing', async () => {
      useFakeTimers()
      const SLOW = 'https://ads.test/slow.xml'
      const h = harness({
        documents: { [TAG]: wrapper({ id: 'w1', tagUri: SLOW }) },
        hanging: [SLOW],
        configuration: { resolutionTimeoutSeconds: 3 },
      })
      const done = h.session.playBreak(TAG, { position: 'preroll' })
      await h.settle()
      expect(h.loader.requests).toEqual([TAG, SLOW])

      await vi.advanceTimersByTimeAsync(2999)
      await h.settle()
      expect(h.events).toEqual([])
      expect(h.snapshot.state).toEqual({ type: 'loading' })

      await vi.advanceTimersByTimeAsync(1)
      const result = await done

      expect(h.loader.aborted, 'the slow request is cancelled, not left running').toEqual([SLOW])
      expect(h.transport.fired).toEqual([])
      expect(h.events).toEqual(['failed null 301', 'all finished'])
      expect(h.content!.calls).toEqual(['pause', 'resume'])
      expect(result).toEqual({ outcome: { type: 'failed', error: VastError.WRAPPER_TIMEOUT }, adsStarted: 0 })
    })

    it('tell a wrapper whose redirect never answers 301, under the default timeouts and the default loader', async () => {
      useFakeTimers()
      const DEAD = 'https://ads.test/dead.xml'
      const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === TAG) return Promise.resolve(new Response(wrapper({ id: 'w1', tagUri: DEAD }), { status: 200 }))
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }) as typeof fetch
      const h = harness({ environment: { loader: new VastFetchLoader('include', fetchImpl) } })
      const done = h.session.playBreak(TAG, { position: 'preroll' })
      await h.settle()
      await vi.advanceTimersByTimeAsync(10_000)
      await done

      expect(h.transport.urls).toEqual(['https://wrapper.test/w1/error?code=301'])
    })

    it('refuse a creative this browser cannot decode with 403 before anything plays', async () => {
      const h = harness({
        documents: { [TAG]: inLine({ id: 'flash', mimeType: 'video/x-flv' }) },
        environment: { canPlayType: (type) => type === 'video/mp4' },
      })
      const result = await h.session.playBreak(TAG, { position: 'preroll' })

      expect(h.transport.urls).toEqual(['https://ads.test/flash/error?code=403'])
      expect(h.events).toEqual(['failed flash 403', 'all finished'])
      expect(h.ad.calls).not.toContain('play')
      expect(result).toEqual({ outcome: { type: 'failed', error: VastError.NO_SUPPORTED_MEDIA_FILE }, adsStarted: 0 })
    })

    it('resolve a response in hand, following a relative <VASTAdTagURI> from its baseUrl', async () => {
      const h = harness({ documents: { 'https://ads.test/tags/inner.xml': inLine('a1') } })
      const done = h.session.playBreak(
        { xml: wrapper({ id: 'w1', tagUri: 'inner.xml' }), baseUrl: 'https://ads.test/tags/outer.xml' },
        { position: 'preroll' },
      )
      await h.settle()

      expect(h.loader.requests).toEqual(['https://ads.test/tags/inner.xml'])
      expect(h.snapshot.currentAd?.id).toBe('a1')
      await h.finishAd()
      expect((await done).outcome).toEqual({ type: 'completed' })
    })

    it('accept the tag as { url } as well as a string', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      void h.session.playBreak({ url: TAG }, { position: 'preroll' })
      await h.settle()
      expect(h.loader.requests).toEqual([TAG])
      expect(h.snapshot.currentAd?.id).toBe('a1')
    })

    it('carry the wrapper trackers through to a successful break', async () => {
      const INNER = 'https://ads.test/inner.xml'
      const h = harness({ documents: { [TAG]: wrapper({ id: 'w1', tagUri: INNER }), [INNER]: inLine('a1') } })
      await startPreroll(h)
      h.play(0, 1)

      expect(h.transport.urls).toContain('https://wrapper.test/w1/impression')
      expect(h.transport.urls).toContain('https://ads.test/a1/impression')
      expect(h.transport.urls).toContain('https://wrapper.test/w1/start')
      expect(h.reported.filter((label) => label === 'impression')).toHaveLength(1)
    })
  })

  // MARK: - The creative failed

  describe('creative failures', () => {
    it.each([
      [MEDIA_ERR.SRC_NOT_SUPPORTED, 401],
      [MEDIA_ERR.NETWORK, 401],
      [MEDIA_ERR.DECODE, 405],
    ])('MediaError %i before the first frame reports %i and a stand-alone substitute takes the slot', async (code, error) => {
      const h = harness({ documents: { [TAG]: response('a1', 'a2') } })
      h.ad.failures.set(mediaUrl('a1'), code)
      const { done } = await startPreroll(h)

      expect(h.transport.urlsFor('https://ads.test/a1/')).toEqual([`https://ads.test/a1/error?code=${error}`])
      expect(h.snapshot.currentAd?.id).toBe('a2')
      expect(h.snapshot.adPosition).toEqual({ index: 1, total: 1 })

      await h.finishAd()
      const result = await done

      expect(h.events).toEqual([`failed a1 ${error}`, 'started a2 1/1', 'finished a2 completed', 'all finished'])
      expect(h.reportedFor.filter((entry) => entry.adId === 'a1').map((entry) => entry.label)).toEqual([`error ${error}`])
      expect(result).toEqual({ outcome: { type: 'completed' }, adsStarted: 1 })
    })

    it('ends the break with the failure when there is no substitute', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      h.ad.failures.set(mediaUrl('a1'), MEDIA_ERR.SRC_NOT_SUPPORTED)
      const result = await h.session.playBreak(TAG, { position: 'preroll' })

      expect(h.events).toEqual(['failed a1 401', 'all finished'])
      expect(result).toEqual({ outcome: { type: 'failed', error: VastError.MEDIA_FILE_NOT_FOUND }, adsStarted: 0 })
      expect(h.content!.calls).toEqual(['pause', 'resume'])
    })

    it('a failure after the first frame ends that ad and is not substituted', async () => {
      const h = harness({ documents: { [TAG]: response('a1', 'a2') } })
      const { done } = await startPreroll(h)
      h.play(0, 3)

      h.ad.fail(MEDIA_ERR.NETWORK)
      await h.settle()
      const result = await done

      expect(h.events).toEqual(['started a1 1/1', 'failed a1 401', 'finished a1 failed 401', 'all finished'])
      expect(h.reported[h.reported.length - 1]).toBe('error 401')
      expect(result).toEqual({ outcome: { type: 'failed', error: VastError.MEDIA_FILE_NOT_FOUND }, adsStarted: 1 })
    })

    it('expands [ERRORCODE] only on error beacons', async () => {
      const h = harness({
        documents: { [TAG]: inLine({ id: 'a1', impressions: ['https://ads.test/a1/impression?e=[ERRORCODE]'] }) },
      })
      await startPreroll(h)
      h.play(0, 1)

      expect(param(h.transport.urlsFor('https://ads.test/a1/impression')[0]!, 'e')).toBe('-1')
    })
  })

  // MARK: - Skip presentation

  describe('skip presentation', () => {
    it('refuses a skippable ad with 200 when nobody can draw the skip control', async () => {
      const h = harness({
        documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:05' }) },
        configuration: { skipPresentation: 'unsupported' },
      })
      const result = await h.session.playBreak(TAG, { position: 'preroll' })

      expect(h.transport.urls).toEqual(['https://ads.test/s1/error?code=200'])
      expect(h.events).toEqual(['failed s1 200', 'all finished'])
      expect(h.ad.calls).not.toContain('play')
      expect(result).toEqual({ outcome: { type: 'failed', error: VastError.TRAFFICKING }, adsStarted: 0 })
      expect(h.content!.calls).toEqual(['pause', 'resume'])
    })

    it('still plays a non-skippable ad under unsupported', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') }, configuration: { skipPresentation: 'unsupported' } })
      await startPreroll(h)
      expect(h.events).toEqual(['started a1 1/1'])
    })

    it('reports skipControlUnavailable when the skip comes due and no control is registered', async () => {
      const h = harness({ documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:02' }) } })
      await startPreroll(h)

      h.play(0, 1)
      expect(h.unavailable, 'asking before the skip is due cannot tell missing from not laid out').toEqual([])
      h.advance(1)
      h.tick(2)
      expect(h.unavailable).toHaveLength(1)
      expect(h.unavailable[0]).toContain('no VastAdOverlay')
      h.play(2, 5)
      expect(h.unavailable, 'once per ad').toHaveLength(1)
    })

    it('does not report a registered control that measures at least 24×24', async () => {
      const h = harness({ documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:02' }) } })
      h.session.registerSkipControl(() => ({ width: 24, height: 24 }))
      await startPreroll(h)
      h.play(0, 3)

      expect(h.skipAvailable).toEqual(['s1'])
      expect(h.unavailable).toEqual([])
    })

    it.each([
      [{ width: 23, height: 40 }, 'too small'],
      [null, 'not rendered'],
    ])('reports a registered control measuring %j as unusable', async (size, reason) => {
      const h = harness({ documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:02' }) } })
      h.session.registerSkipControl(() => size)
      await startPreroll(h)
      h.play(0, 3)

      expect(h.unavailable).toHaveLength(1)
      expect(h.unavailable[0]).toContain(reason)
    })

    it('forgets a control once it unregisters', async () => {
      const h = harness({ documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:02' }) } })
      const unregister = h.session.registerSkipControl(() => ({ width: 48, height: 48 }))
      unregister()
      await startPreroll(h)
      h.play(0, 3)

      expect(h.unavailable).toHaveLength(1)
    })

    it('does not police a control the host draws itself', async () => {
      const h = harness({
        documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:02' }) },
        configuration: { skipPresentation: 'host' },
      })
      await startPreroll(h)
      h.play(0, 3)

      expect(h.snapshot.canSkip).toBe(true)
      expect(h.unavailable).toEqual([])
    })
  })

  describe('hidden UI', () => {
    it('hands the controls to the host when it allowed it and the response asks for it', async () => {
      const h = harness({
        documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:02', extensions: UI_HIDDEN }) },
        configuration: { allowsHiddenUi: true },
      })
      expect(h.snapshot.effectiveSkipPresentation).toBe('sdk')
      await startPreroll(h)

      expect(h.snapshot.suppressesAdUi).toBe(true)
      expect(h.snapshot.effectiveSkipPresentation).toBe('host')
      h.play(0, 3)
      expect(h.unavailable, 'the host owns the control now').toEqual([])

      await h.finishAd()
      expect(h.snapshot.suppressesAdUi).toBe(false)
      expect(h.snapshot.effectiveSkipPresentation).toBe('sdk')
    })

    it('keeps the SDK UI when the host did not allow hidden UI, whatever the response says', async () => {
      const h = harness({ documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:02', extensions: UI_HIDDEN }) } })
      await startPreroll(h)

      expect(h.snapshot.suppressesAdUi).toBe(false)
      expect(h.snapshot.effectiveSkipPresentation).toBe('sdk')
      h.play(0, 3)
      expect(h.unavailable).toHaveLength(1)
    })
  })

  // MARK: - Holds and pauses

  describe('holds', () => {
    it('hold the ad on a hidden page without reporting a pause, and resume it when visible', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      const { done } = await startPreroll(h)
      h.play(0, 3)

      h.setPageVisible(false)
      await h.settle()
      expect(h.ad.paused).toBe(true)
      expect(h.snapshot.state, 'a hold is not a pause the host should draw').toEqual({ type: 'playing' })

      // Held for longer than the stall timeout: the playhead is meant to be still.
      h.stuck(3, 30)
      expect(h.reported).not.toContain('error 402')

      h.setPageVisible(true)
      await h.settle()
      expect(h.ad.paused).toBe(false)

      h.play(3, 10)
      h.ad.reachEnd()
      await h.settle()
      const result = await done

      expect(h.reported).not.toContain('pause')
      expect(h.reported).not.toContain('resume')
      expect(h.reported).toContain('complete')
      expect(result.outcome).toEqual({ type: 'completed' })
    })

    it('hold an ad that starts while the page is hidden from its first frame', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') }, pageVisible: false })
      await startPreroll(h)

      expect(h.events).toEqual(['started a1 1/1'])
      expect(h.ad.paused).toBe(true)

      h.setPageVisible(true)
      await h.settle()
      expect(h.ad.paused).toBe(false)
      expect(h.reported).not.toContain('resume')
    })

    it('leave a viewer pause alone when the page hides and shows again', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      await startPreroll(h)
      h.play(0, 3)
      h.session.pause()
      await h.settle()

      h.setPageVisible(false)
      h.setPageVisible(true)
      await h.settle()

      expect(h.ad.paused, 'coming back must not undo the viewer’s pause').toBe(true)
      expect(h.snapshot.state).toEqual({ type: 'paused' })
    })

    it('do not outlive a creative that failed while held: the next one is held again', async () => {
      const h = harness({ documents: { [TAG]: response({ id: 'p1', sequence: 1 }, { id: 'p2', sequence: 2 }) } })
      await startPreroll(h)
      h.play(0, 3)
      h.setPageVisible(false)
      await h.settle()
      expect(h.ad.paused).toBe(true)

      h.ad.fail(MEDIA_ERR.NETWORK)
      await h.settle()
      expect(h.snapshot.currentAd?.id).toBe('p2')

      expect(h.ad.paused, 'p2 started on a hidden page and was not held').toBe(true)
    })

    it('do nothing between breaks', () => {
      const h = harness()
      h.setPageVisible(false)
      h.setPageVisible(true)
      expect(h.ad.calls).toEqual([])
    })
  })

  describe('pausing', () => {
    it('session.pause() and resume() are reported as pause and resume', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      const { done } = await startPreroll(h)
      h.play(0, 3)

      h.session.pause()
      await h.settle()
      expect(h.snapshot.state).toEqual({ type: 'paused' })
      expect(h.ad.paused).toBe(true)

      // Paused for longer than the stall timeout: a viewer's pause is not a stall.
      h.stuck(3, 30)
      expect(h.reported).not.toContain('error 402')

      h.session.resume()
      await h.settle()
      expect(h.snapshot.state).toEqual({ type: 'playing' })

      h.play(3, 10)
      h.ad.reachEnd()
      await h.settle()
      const result = await done

      expect(h.reported.filter((label) => label === 'pause')).toHaveLength(1)
      expect(h.reported.filter((label) => label === 'resume')).toHaveLength(1)
      expect(h.reported.indexOf('pause')).toBeLessThan(h.reported.indexOf('resume'))
      expect(result.outcome).toEqual({ type: 'completed' })
    })

    it('reports a stop the session did not cause — a headset button — as a pause', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      await startPreroll(h)
      h.play(0, 3)

      h.ad.externalPause()
      await h.settle()

      expect(h.reported[h.reported.length - 1]).toBe('pause')
      expect(h.snapshot.state).toEqual({ type: 'paused' })
    })

    it('does not report a stop in the last half second as a pause', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      const { done } = await startPreroll(h)
      h.play(0, 9)
      h.advance(0.72)
      h.tick(9.72)

      h.ad.externalPause()
      await h.settle()
      h.ad.reachEnd()
      await h.settle()
      await done

      expect(h.reported).not.toContain('pause')
      expect(h.reported[h.reported.length - 1]).toBe('complete')
    })

    it('ignores pause and resume outside a playing ad', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') }, autoStart: false })
      h.session.pause()
      h.session.resume()
      void h.session.playBreak(TAG, { position: 'preroll' })
      await h.settle()
      h.session.pause()

      expect(h.ad.calls).not.toContain('pause')
      expect(h.reported).toEqual([])
    })
  })

  // MARK: - Sound

  describe('sound', () => {
    it('starts muted when the browser refuses sound, unreported, and reports unmute when the viewer unmutes', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') }, autoplay: 'mutedOnly' })
      await startPreroll(h)

      expect(h.ad.calls.slice(0, 3)).toEqual(['load', 'play:refused', 'play'])
      expect(h.session.adPlayer.video.muted).toBe(true)
      expect(h.snapshot.isMuted).toBe(true)
      expect(h.snapshot.mutedByAutoplayPolicy).toBe(true)

      h.play(0, 2)
      expect(h.reported, 'a muted start nobody chose is not a mute').not.toContain('mute')

      h.session.setMuted(false)
      expect(h.session.adPlayer.video.muted).toBe(false)
      expect(h.snapshot.isMuted).toBe(false)
      expect(h.snapshot.mutedByAutoplayPolicy).toBe(false)
      expect(h.reported[h.reported.length - 1]).toBe('unmute')
      expect(h.transport.urls).toContain('https://ads.test/a1/unmute')

      h.session.setMuted(true)
      expect(h.reported[h.reported.length - 1]).toBe('mute')
    })

    it('fails the ad with 405 when the browser refuses playback even muted', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') }, autoplay: 'refused' })
      const result = await h.session.playBreak(TAG, { position: 'preroll' })

      expect(h.ad.calls.filter((call) => call === 'play:refused')).toHaveLength(2)
      expect(h.transport.urls).toEqual(['https://ads.test/a1/error?code=405'])
      expect(h.events).toEqual(['failed a1 405', 'all finished'])
      expect(result).toEqual({ outcome: { type: 'failed', error: VastError.MEDIA_FILE_DISPLAY_PROBLEM }, adsStarted: 0 })
      expect(h.content!.calls).toEqual(['pause', 'resume'])
    })

    it('starts as loud as the content and never louder than the viewer chose', async () => {
      const content = new FakeContent()
      content.muted = true
      content.volume = 0.4
      const h = harness({ documents: { [TAG]: inLine('a1') }, content })
      await startPreroll(h)

      expect(h.session.adPlayer.video.muted).toBe(true)
      expect(h.session.adPlayer.video.volume).toBe(0.4)
      expect(h.snapshot.isMuted).toBe(true)
      expect(h.snapshot.mutedByAutoplayPolicy).toBe(false)

      h.play(0, 1)
      h.session.setMuted(true)
      expect(h.reported, 'already muted: nothing changed').not.toContain('mute')
    })
  })

  // MARK: - Stalls and timeouts

  describe('stalls and timeouts', () => {
    it('writes off a playhead stuck while playing for more than ten seconds of uptime as 402', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      const { done } = await startPreroll(h)
      h.play(0, 3)

      h.stuck(3, 10)
      expect(h.reported, 'exactly ten seconds is not yet a stall').not.toContain('error 402')
      h.stuck(3, 1)

      expect(h.transport.urlsFor('https://ads.test/a1/error')).toEqual(['https://ads.test/a1/error?code=402'])
      expect(h.events).toContain('failed a1 402')
      await h.settle()
      const result = await done
      expect(result.adsStarted).toBe(1)
      expect(h.content!.calls).toEqual(['pause', 'resume'])
    })

    it('gives a stalled ad the outcome it reported: failed 402', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      const { done } = await startPreroll(h)
      h.play(0, 3)
      h.stuck(3, 11)
      await h.settle()
      const result = await done

      expect(h.events).toContain('finished a1 failed 402')
      expect(result.outcome).toEqual({ type: 'failed', error: VastError.MEDIA_FILE_TIMEOUT })
    })

    it('tells the host about a stall even when the ad has no <Error> to report it to', async () => {
      const h = harness({ documents: { [TAG]: inLine({ id: 'a1', withError: false }) } })
      await startPreroll(h)
      h.play(0, 3)
      h.stuck(3, 11)
      await h.settle()

      expect(h.events).toContain('failed a1 402')
    })

    it('treats a stall after the creative was watched through as its end, not a failure', async () => {
      const h = harness({ documents: { [TAG]: inLine({ id: 'a1', duration: '00:00:30' }) } })
      const { done } = await startPreroll(h)
      h.play(0, 29)
      h.advance(0.5)
      h.tick(29.5)
      h.stuck(29.5, 11)
      await h.settle()
      const result = await done

      expect(h.reported).not.toContain('error 402')
      expect(h.reported).toContain('complete')
      expect(result.outcome).toEqual({ type: 'completed' })
    })

    it('fails a creative that never shows a frame within mediaLoadTimeoutSeconds with 402', async () => {
      useFakeTimers()
      const h = harness({ documents: { [TAG]: inLine('a1') }, autoStart: false, configuration: { mediaLoadTimeoutSeconds: 8 } })
      const done = h.session.playBreak(TAG, { position: 'preroll' })
      await h.settle()
      expect(h.ad.calls).toContain('play')
      expect(h.snapshot.state).toEqual({ type: 'loading' })

      await vi.advanceTimersByTimeAsync(7999)
      await h.settle()
      expect(h.events).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      await h.settle()
      const result = await done

      expect(h.transport.urls).toEqual(['https://ads.test/a1/error?code=402'])
      expect(h.events).toEqual(['failed a1 402', 'all finished'])
      expect(result).toEqual({ outcome: { type: 'failed', error: VastError.MEDIA_FILE_TIMEOUT }, adsStarted: 0 })
      expect(h.ad.source, 'the element let go of the creative').toBeNull()
    })

    it('does not time out a creative that started in time', async () => {
      useFakeTimers()
      const h = harness({ documents: { [TAG]: inLine('a1') }, autoStart: false, configuration: { mediaLoadTimeoutSeconds: 8 } })
      void h.session.playBreak(TAG, { position: 'preroll' })
      await h.settle()
      await vi.advanceTimersByTimeAsync(5000)
      h.ad.startPlayback()
      await h.settle()
      await vi.advanceTimersByTimeAsync(10_000)
      await h.settle()

      expect(h.events).toEqual(['started a1 1/1'])
      expect(h.reported).not.toContain('error 402')
    })
  })

  // MARK: - Breaks on demand

  describe('breaks on demand', () => {
    it('queue behind the break on screen, and the content comes back once, after the last', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      const counts: number[] = []
      h.session.subscribe(() => counts.push(h.session.getSnapshot().pendingBreakCount))
      const { done: first } = await startPreroll(h)

      const second = h.session.playBreak({ xml: inLine('m1') }, { position: 'midroll' })
      expect(h.snapshot.pendingBreakCount).toBe(1)

      await h.finishAd()
      expect((await first).outcome).toEqual({ type: 'completed' })
      expect(h.snapshot.pendingBreakCount).toBe(0)
      expect(h.snapshot.currentAd?.id).toBe('m1')
      expect(h.content!.calls, 'two breaks asked for together are one interruption').toEqual(['pause'])

      await h.finishAd()
      expect((await second).outcome).toEqual({ type: 'completed' })
      expect(h.content!.calls).toEqual(['pause', 'resume'])
      expect(h.events).toEqual([
        'started a1 1/1',
        'finished a1 completed',
        'all finished',
        'started m1 1/1',
        'finished m1 completed',
        'all finished',
      ])
      // Each break is counted while it waits — even the first, for the moment
      // before the queue takes it — and nothing else is ever published.
      expect(counts.filter((count, i) => i === 0 || count !== counts[i - 1])).toEqual([1, 0, 1, 0])
    })

    it('a midroll that resolves to nothing never pauses the content or changes the state', async () => {
      const h = harness({ documents: { [TAG]: noAd() } })
      const result = await h.session.playBreak(TAG, { position: 'midroll' })

      expect(h.content!.calls).toEqual([])
      expect(h.states).not.toContain('loading')
      expect(h.snapshot.state).toEqual({ type: 'idle' })
      expect(h.events).toEqual(['failed null 303'])
      expect(h.session.adPlayer.layer.style.display).toBe('none')
      expect(result).toEqual({ outcome: { type: 'failed', error: VastError.NO_VAST_RESPONSE_AFTER_WRAPPERS }, adsStarted: 0 })
    })

    it('a midroll leaves the content playing while it resolves and pauses it once an ad is ready', async () => {
      const h = harness({ documents: { [TAG]: inLine('m1') } })
      const done = h.session.playBreak(TAG, { position: 'midroll' })
      expect(h.content!.calls).toEqual([])
      expect(h.snapshot.state).toEqual({ type: 'idle' })

      await h.settle()
      expect(h.content!.calls).toEqual(['pause'])
      await h.finishAd()
      await done
      expect(h.content!.calls).toEqual(['pause', 'resume'])
    })

    it('an empty break queued behind another still lets the next one play', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      await startPreroll(h)
      const empty = h.session.playBreak({ xml: noAd() }, { position: 'midroll' })
      const next = h.session.playBreak({ xml: inLine('m2') }, { position: 'midroll' })
      expect(h.snapshot.pendingBreakCount).toBe(2)

      await h.finishAd()
      expect((await empty).adsStarted).toBe(0)
      expect(h.snapshot.currentAd?.id).toBe('m2')
      expect(h.content!.calls).toEqual(['pause'])

      await h.finishAd()
      expect((await next).adsStarted).toBe(1)
      expect(h.content!.calls).toEqual(['pause', 'resume'])
      expect(h.events).toContain('failed null 303')
    })

    it('pauses and resumes a plain <video> through htmlVideoContent', async () => {
      const contentVideo = document.createElement('video')
      const contentMedia = new ScriptedMedia(contentVideo)
      contentVideo.controls = true
      contentMedia.paused = false
      contentMedia.readyState = 4
      const h = harness({ documents: { [TAG]: inLine('a1') }, content: null })
      const session = new VastAdSession({
        container: h.container,
        content: htmlVideoContent(contentVideo),
        configuration: { clock: h.clock, mediaLoadTimeoutSeconds: 0 },
        environment: { transport: h.transport, loader: h.loader, canPlayType: () => true },
      })
      try {
        const ad = new ScriptedMedia(session.adPlayer.video)
        const done = session.playBreak(TAG, { position: 'preroll' })
        expect([contentMedia.paused, contentVideo.controls]).toEqual([true, false])
        await h.settle()

        h.play(0, 10)
        ad.reachEnd()
        await h.settle()
        await done
        expect([contentMedia.paused, contentVideo.controls]).toEqual([false, true])
      } finally {
        session.destroy()
      }
    })

    it('carries on when the content player throws', async () => {
      class BrokenContent extends FakeContent {
        override pauseForBreak(): void {
          throw new Error('host bug')
        }

        override resumeAfterBreak(): void {
          throw new Error('host bug')
        }
      }
      const h = harness({ documents: { [TAG]: inLine('a1') }, content: new BrokenContent() })
      const { done } = await startPreroll(h)
      await h.finishAd()
      expect((await done).outcome).toEqual({ type: 'completed' })
    })

    it('plays without a content player at all', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') }, content: null })
      const { done } = await startPreroll(h)
      await h.finishAd()
      expect((await done).outcome).toEqual({ type: 'completed' })
    })
  })

  // MARK: - What was reported

  describe('reported', () => {
    it('fires once for three <Impression> URLs, while all three go out', async () => {
      const impressions = ['https://ads.test/a1/impression', 'https://imp2.test/a1', 'https://imp3.test/a1']
      const h = harness({ documents: { [TAG]: inLine({ id: 'a1', impressions }) } })
      await startPreroll(h)
      h.play(0, 1)

      expect(h.transport.fired.filter((beacon) => beacon.kind.type === 'impression').map((beacon) => beacon.url)).toEqual(
        impressions,
      )
      expect(h.reported.filter((label) => label === 'impression')).toHaveLength(1)
    })

    it('mirrors a click: tracking fired, destination handed back', async () => {
      const h = harness({ documents: { [TAG]: inLine({ id: 'a1', clickThrough: 'https://advertiser.test/landing' }) } })
      expect(h.session.click(), 'no ad, no click').toBeNull()
      await startPreroll(h)

      expect(h.session.click()).toBe('https://advertiser.test/landing')
      expect(h.reported[h.reported.length - 1]).toBe('clickTracking')
      expect(h.transport.urls).toContain('https://ads.test/a1/click')
    })

    it('opens the click-through in a new tab only through openClickThrough', async () => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      const h = harness({ documents: { [TAG]: inLine({ id: 'a1', clickThrough: 'https://advertiser.test/landing' }) } })
      await startPreroll(h)

      h.session.click()
      expect(open).not.toHaveBeenCalled()
      h.session.openClickThrough()
      expect(open).toHaveBeenCalledWith('https://advertiser.test/landing', '_blank', 'noopener,noreferrer')
    })

    it('refuses to let the host fabricate a billable event', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      await startPreroll(h)
      h.session.report('start')
      h.session.report('complete')
      h.session.report('skip')

      expect(h.reported).toEqual(['loaded'])
    })

    it('says so when a TV left on surface clicks has no click path', async () => {
      const h = harness({
        documents: { [TAG]: inLine({ id: 'a1', clickThrough: 'https://advertiser.test/landing' }) },
        environment: { isTelevision: true },
      })
      const reasons: string[] = []
      h.session.on('clickThroughUnavailable', (_ad, reason) => reasons.push(reason))
      await startPreroll(h)

      expect(reasons).toHaveLength(1)
    })

    it('keeps the break going when a host handler throws', async () => {
      const h = harness({ documents: { [TAG]: inLine('a1') } })
      h.session.on('adStarted', () => {
        throw new Error('host bug')
      })
      h.session.subscribe(() => {
        throw new Error('host bug')
      })
      const { done } = await startPreroll(h)
      await h.finishAd()

      expect((await done).outcome).toEqual({ type: 'completed' })
    })
  })

  // MARK: - Macros

  describe('macros', () => {
    const tagged = (id: string, query: string) => inLine({ id, impressions: [`https://ads.test/${id}/impression?${query}`] })
    const impression = (h: Harness, id: string) => h.transport.urlsFor(`https://ads.test/${id}/impression`)[0]!

    it.each([
      ['preroll', '1'],
      ['midroll', '2'],
      ['postroll', '3'],
    ] as const)('[BREAKPOSITION] for a %s is %s', async (position, code) => {
      const h = harness({ documents: { [TAG]: tagged('a1', 'bp=[BREAKPOSITION]') } })
      void h.session.playBreak(TAG, { position })
      await h.settle()
      h.play(0, 1)

      expect(param(impression(h, 'a1'), 'bp')).toBe(code)
    })

    it('[BREAKPOSITION] is unknown when the host gave no position, and the host value wins when it gave one', async () => {
      const unknown = harness({ documents: { [TAG]: tagged('a1', 'bp=[BREAKPOSITION]') } })
      void unknown.session.playBreak(TAG)
      await unknown.settle()
      unknown.play(0, 1)
      expect(param(impression(unknown, 'a1'), 'bp')).toBe('-1')

      const host = harness({
        documents: { [TAG]: tagged('a1', 'bp=[BREAKPOSITION]') },
        configuration: { macroValues: { breakPosition: 3 } },
      })
      void host.session.playBreak(TAG, { position: 'preroll' })
      await host.settle()
      host.play(0, 1)
      expect(param(impression(host, 'a1'), 'bp')).toBe('3')
    })

    it('[PAGEURL] and [DOMAIN] come from the page, each value encoded', async () => {
      const h = harness({ documents: { [TAG]: tagged('a1', 'page=[PAGEURL]&domain=[DOMAIN]') } })
      await startPreroll(h)
      h.play(0, 1)

      const url = impression(h, 'a1')
      expect(param(url, 'page')).toBe(PAGE_URL)
      expect(rawParam(url, 'page')).toBe(encodeURIComponent(PAGE_URL))
      expect(param(url, 'domain')).toBe('www.example.com')
    })

    it('[CONTENTPLAYHEAD] is where the content was interrupted', async () => {
      const h = harness({ documents: { [TAG]: tagged('a1', 'cp=[CONTENTPLAYHEAD]') } })
      await startPreroll(h)
      h.play(0, 1)

      expect(param(impression(h, 'a1'), 'cp')).toBe('00:00:42.000')
    })

    it('[TRANSACTIONID] is one value for a whole break and a new one for the next', async () => {
      const txn = 'txn=[TRANSACTIONID]'
      const h = harness({
        documents: {
          [TAG]: response(
            { id: 'p1', sequence: 1, impressions: [`https://ads.test/p1/impression?${txn}`, `https://two.test/p1?${txn}`] },
            { id: 'p2', sequence: 2, impressions: [`https://ads.test/p2/impression?${txn}`] },
          ),
        },
      })
      const { done: first } = await startPreroll(h)
      const second = h.session.playBreak({ xml: tagged('m1', txn) }, { position: 'midroll' })
      await h.finishAd()
      await h.finishAd()
      await first
      await h.finishAd()
      await second

      const values = (prefix: string) => h.transport.urlsFor(prefix).map((url) => param(url, 'txn'))
      expect([...values('https://ads.test/p1/impression'), ...values('https://two.test/p1'), ...values('https://ads.test/p2/impression')]).toEqual([
        'txn-1',
        'txn-1',
        'txn-1',
      ])
      expect(values('https://ads.test/m1/impression')).toEqual(['txn-2'])
      expect(h.randomIds).toBe(2)
    })

    it('expands the wrapper error beacons of a failed break too', async () => {
      const h = harness({
        documents: {
          [TAG]: wrapper({ id: 'w1', tagUri: 'https://ads.test/missing.xml' }).replace(
            'error?code=[ERRORCODE]',
            'error?code=[ERRORCODE]&bp=[BREAKPOSITION]&txn=[TRANSACTIONID]',
          ),
        },
      })
      await h.session.playBreak(TAG, { position: 'postroll' })

      const url = h.transport.urls[0]!
      expect([param(url, 'code'), param(url, 'bp'), param(url, 'txn')]).toEqual(['301', '3', 'txn-1'])
    })
  })

  // MARK: - Destroying

  describe('destroy', () => {
    it('mid-break resolves the pending promise, frees the element, and fires nothing further', async () => {
      const measurement = new FakeMeasurement()
      const h = harness({ documents: { [TAG]: inLine({ id: 's1', skipOffset: '00:00:02' }) }, measurement })
      const { done } = await startPreroll(h)
      const queued = h.session.playBreak({ xml: inLine('m1') }, { position: 'midroll' })
      h.play(0, 3)
      const before = h.transport.fired.length

      h.session.destroy()
      const result = await done

      expect(result.outcome).toEqual({ type: 'failed', error: VastError.UNDEFINED })
      expect((await queued).outcome).toEqual({ type: 'failed', error: VastError.UNDEFINED })
      expect(h.container.contains(h.session.adPlayer.layer)).toBe(false)
      expect(h.ad.source).toBeNull()
      expect(h.clock.running).toBe(false)
      expect(h.visibilityStopCount).toBe(1)
      expect(h.snapshot.state).toEqual({ type: 'idle' })
      expect(h.snapshot.currentAd).toBeNull()

      // Nothing the element, the page or the host does now reaches the ad server.
      h.ad.reachEnd()
      h.setPageVisible(false)
      expect(h.tick(4)).toBe(false)
      h.session.pause()
      h.session.click()
      h.session.report('mute')
      expect(skipError(() => h.session.skip()).reason).toBe('noActiveAd')
      await h.settle()

      expect(h.transport.fired).toHaveLength(before)
      expect(measurement.recorded.filter((entry) => entry === 'finish')).toHaveLength(1)
      expect(h.events).toEqual(['started s1 1/1'])
      expect(await h.session.playBreak(TAG, { position: 'preroll' })).toEqual({
        outcome: { type: 'failed', error: VastError.UNDEFINED },
        adsStarted: 0,
      })
    })

    it('while resolving cancels the request and reports nothing', async () => {
      const h = harness({ hanging: [TAG] })
      const done = h.session.playBreak(TAG, { position: 'preroll' })
      await h.settle()

      h.session.destroy()
      const result = await done
      await h.settle()

      expect(h.loader.aborted).toEqual([TAG])
      expect(result.outcome).toEqual({ type: 'failed', error: VastError.UNDEFINED })
      expect(h.transport.fired).toEqual([])
      expect(h.events).toEqual([])
    })

    it('is idempotent', () => {
      const h = harness()
      h.session.destroy()
      h.session.destroy()
      expect(h.visibilityStopCount).toBe(1)
    })
  })

  // MARK: - Measurement

  describe('measurement', () => {
    it('begins before the impression, hears the beacon sequence, and finishes exactly once', async () => {
      const measurement = new FakeMeasurement()
      const h = harness({ documents: { [TAG]: inLine({ id: 'a1', verifications: VERIFICATION }) }, measurement })
      const { done } = await startPreroll(h)
      await h.finishAd()
      await done

      expect(measurement.recorded).toEqual([
        'begin a1',
        'impression',
        'start 10',
        'quartile firstQuartile',
        'quartile midpoint',
        'quartile thirdQuartile',
        'quartile complete',
        'finish',
      ])
      const context = measurement.contexts[0]!
      expect(context.videoElement).toBe(h.session.adPlayer.video)
      expect(context.slotElement).toBe(h.session.adPlayer.layer)
      expect(context.verifications.map((v) => v.vendor)).toEqual(['measure.test-omid'])
    })

    it('owns verificationNotExecuted when set; without it every vendor that asked is told', async () => {
      const measured = harness({
        documents: { [TAG]: inLine({ id: 'a1', verifications: VERIFICATION }) },
        measurement: new FakeMeasurement(),
      })
      await startPreroll(measured)
      measured.play(0, 1)
      expect(measured.reported.some((label) => label.startsWith('verificationNotExecuted'))).toBe(false)
      expect(measured.transport.urlsFor('https://measure.test/')).toEqual([])

      const unmeasured = harness({ documents: { [TAG]: inLine({ id: 'a1', verifications: VERIFICATION }) } })
      await startPreroll(unmeasured)
      unmeasured.play(0, 1)
      expect(unmeasured.reported).toContain('verificationNotExecuted 3')
      expect(unmeasured.transport.urlsFor('https://measure.test/')).toEqual(['https://measure.test/not-executed?reason=3'])
    })

    it('finishes exactly once per begin, however each ad ends', async () => {
      const measurement = new FakeMeasurement()
      const h = harness({
        documents: {
          [TAG]: response(
            { id: 'p1', sequence: 1, skipOffset: '00:00:02' },
            { id: 'p2', sequence: 2 },
            { id: 'p3', sequence: 3 },
          ),
        },
        measurement,
      })
      const { done } = await startPreroll(h)
      h.play(0, 3)
      h.session.skip()
      await h.settle()
      h.play(0, 3)
      h.ad.fail(MEDIA_ERR.DECODE)
      await h.settle()
      h.play(0, 3)
      h.stuck(3, 11)
      await h.settle()
      await done

      const lifecycle = measurement.recorded.filter((entry) => entry.startsWith('begin') || entry === 'finish')
      expect(lifecycle).toEqual(['begin p1', 'finish', 'begin p2', 'finish', 'begin p3', 'finish'])
    })

    it('is never begun for a creative that failed before its first frame', async () => {
      const measurement = new FakeMeasurement()
      const h = harness({ documents: { [TAG]: inLine('a1') }, measurement })
      h.ad.failures.set(mediaUrl('a1'), MEDIA_ERR.SRC_NOT_SUPPORTED)
      await h.session.playBreak(TAG, { position: 'preroll' })

      expect(measurement.recorded.filter((entry) => entry.startsWith('begin') || entry === 'finish')).toEqual([])
    })
  })

  // MARK: - Media session

  describe('media session', () => {
    it('describes the ad during the break, routes play and pause to it, and gives everything back after', async () => {
      const mediaSession = new FakeMediaSession()
      const film = { title: 'The Film' }
      mediaSession.metadata = film
      const h = harness({ documents: { [TAG]: inLine({ id: 'a1', title: 'Brand Spot' }) }, mediaSession })
      const { done } = await startPreroll(h)
      h.play(0, 3)

      expect(mediaSession.metadata).toMatchObject({ title: 'Brand Spot' })
      for (const action of ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack', 'skipad']) {
        expect(typeof mediaSession.handlers.get(action), `${action} is switched off, not left to the content`).toBe('function')
      }

      // A headset's pause and play are the viewer's own choice.
      mediaSession.invoke('pause')
      await h.settle()
      expect(h.reported[h.reported.length - 1]).toBe('pause')
      mediaSession.invoke('play')
      await h.settle()
      expect(h.reported[h.reported.length - 1]).toBe('resume')

      h.play(3, 10)
      h.ad.reachEnd()
      await h.settle()
      await done

      expect(mediaSession.metadata).toBe(film)
      expect([...mediaSession.handlers.values()].every((handler) => handler === null)).toBe(true)
    })

    it('names an ad with no <AdTitle> by the page-language fallback', async () => {
      const mediaSession = new FakeMediaSession()
      const h = harness({ documents: { [TAG]: inLine('a1') }, mediaSession })
      await startPreroll(h)

      expect(mediaSession.metadata).toMatchObject({ title: 'Advertisement' })
    })

    it('is left alone under untouched', async () => {
      const mediaSession = new FakeMediaSession()
      const film = { title: 'The Film' }
      mediaSession.metadata = film
      const h = harness({ documents: { [TAG]: inLine('a1') }, mediaSession, configuration: { mediaSession: 'untouched' } })
      await startPreroll(h)

      expect(mediaSession.metadata).toBe(film)
      expect(mediaSession.handlers.size).toBe(0)
    })
  })

  // MARK: - Delivery

  describe('delivery', () => {
    it('flushes what an earlier page left in the retry queue as soon as the session exists', async () => {
      const store = new Map<string, string>()
      const storage: VastKeyValueStorage = {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
      }
      const queue = new VastBeaconQueue(storage)
      queue.enqueue(['https://ads.test/left-over'])
      const requested: string[] = []
      const fetchImpl = ((input: RequestInfo | URL) => {
        requested.push(String(input))
        return Promise.resolve(new Response(null))
      }) as typeof fetch

      const h = harness({ environment: { transport: new VastFetchTransport(queue, 2, 5000, fetchImpl) } })
      await h.settle()

      expect(requested).toEqual(['https://ads.test/left-over'])
      expect(queue.count()).toBe(0)
    })
  })
})
