import { describe, expect, it } from 'vitest'
import { extensionValue, isSkippable, type VastAd } from '../src/VastAd.js'
import { VastParser } from '../src/VastParser.js'
import { VastTrackingEngine } from '../src/VastTrackingEngine.js'
import type { VastTrackingEvent } from '../src/VastTrackingEvent.js'
import { isUiHidden } from '../src/VastUiSettings.js'
import { fixture, inLine, lastPathComponent, query } from './support.js'

/**
 * Behaviour learned from a live ad server rather than from the specification.
 * Every case here corresponds to something a real tag did that spec-shaped
 * fixtures do not.
 */
describe('VastRealWorldTag', () => {
  function adFoxAd(): VastAd {
    return inLine(new VastParser().parse(fixture('legacy-events')).entries[0])
  }

  /** The tag sends VAST 2.0/3.0 names. Dropping them loses tracking the server is waiting for. */
  it('legacyEventNamesAreParsed', () => {
    const parsed = new Set(Object.keys(adFoxAd().linear.trackingEvents))

    const legacyNames: VastTrackingEvent[] = ['fullscreen', 'expand', 'collapse', 'acceptInvitation', 'close']
    for (const legacy of legacyNames) {
      expect(parsed.has(legacy), `${legacy} was dropped`).toBe(true)
    }
    expect(parsed.size, "16 of the tag's 17 events are well-formed").toBe(16)
  })

  /** `progress` requires an offset (§3.14.1). This server sends `offset=""`, so it is discarded rather than guessed at. */
  it('progressEventWithEmptyOffsetIsDiscarded', () => {
    expect(adFoxAd().linear.progressEvents.length === 0).toBe(true)
  })

  /** §3.14.1 says `playerExpand` replaces `fullscreen`, but servers still send the old name. */
  it('firingPlayerExpandAlsoFiresLegacyFullscreenUri', () => {
    const engine = new VastTrackingEngine(adFoxAd())
    engine.advance({ adTime: 0.0, duration: 24.0, rate: 1, wallClock: 0.0 })
    engine.advance({ adTime: 1.0, duration: 24.0, rate: 1, wallClock: 1.0 })

    const fired = engine.report('playerExpand').map((beacon) => lastPathComponent(beacon.url))
    expect(new Set(fired)).toEqual(new Set(['fullscreen', 'expand']))
  })

  it('skipOffsetAndDurationFromLiveTag', () => {
    const ad = adFoxAd()
    expect(ad.linear.duration).toBe(24.0)
    expect(ad.linear.skipOffset).toEqual({ type: 'time', seconds: 15.0 })
    expect(isSkippable(ad)).toBe(true)
  })

  /** `<Icons>` must not disturb the Linear creative around it. */
  it('iconsElementDoesNotCorruptSurroundingCreative', () => {
    const ad = adFoxAd()
    expect(ad.linear.mediaFiles.length).toBe(1)
    expect(ad.linear.clickTracking.length).toBe(1)
    expect(ad.linear.clickThrough).not.toBeNull()
  })

  /** The vendor extension is handed over verbatim; the SDK assigns it no meaning. */
  it('vendorExtensionIsExposedRaw', () => {
    const uiSettings = adFoxAd().extensions.find((extension) => extension.type === 'uiSettings')!
    expect(uiSettings.xml.includes('UiHideable')).toBe(true)
    expect(extensionValue(uiSettings, 'UiHideable'), 'read without scanning the string by hand').toBe('1')
  })
})

/**
 * The tag KinodaranAds' own ad server returns, which is the one this SDK was
 * written to read. Here for the day the server changes its VAST output and the
 * SDK stops understanding it without anybody noticing, because the demo would
 * simply show no ad.
 */
describe('VastKinodaranAdServerTag', () => {
  const document = new VastParser().parse(fixture('kinodaran-adserver'))
  const ad = inLine(document.entries[0])

  /** 3.0 from a server whose editor speaks 4.x, and the whole creative has to come through intact. */
  it('theServersOwnDocumentParses', () => {
    expect(document.version).toBe('3.0')
    expect(document.entries.length).toBe(1)
    expect(ad.adSystem).toBe('KinodaranAds')
    expect(ad.title).toBe('TestVast')
    expect(ad.linear.duration).toBe(30.0)
    expect(ad.linear.skipOffset).toEqual({ type: 'time', seconds: 5.0 })
    expect(isSkippable(ad), 'the skip control is what the creative was sold with').toBe(true)
  })

  /** Six events, one impression and one error URI: the whole of what the ad server counts by. */
  it('everythingTheServerCountsByIsParsed', () => {
    expect(new Set(Object.keys(ad.linear.trackingEvents))).toEqual(
      new Set(['start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete', 'skip']),
    )
    expect(ad.impressions.length).toBe(1)
    expect(ad.errors.length).toBe(1)

    // Long query strings inside CDATA, with raw ampersands: every parameter has
    // to survive, because the signature covers them.
    const impressionQuery = query(ad.impressions[0]!)
    expect(impressionQuery).not.toBeNull()
    expect(impressionQuery!.includes('event_type=impression')).toBe(true)
    expect(impressionQuery!.includes('impression_id=')).toBe(true)
    expect(impressionQuery!.includes('sig=')).toBe(true)
  })

  /** A linear ad with nowhere to click is still a linear ad. */
  it('aCreativeWithNowhereToClickIsStillPlayable', () => {
    expect(ad.linear.clickThrough).toBeNull()
    expect(ad.linear.clickTracking.length === 0).toBe(true)
    expect(ad.linear.customClicks.length === 0).toBe(true)

    // `single()` in the Kotlin.
    expect(ad.linear.mediaFiles).toHaveLength(1)
    const file = ad.linear.mediaFiles[0]!
    expect(file.mimeType).toBe('video/mp4')
    expect(file.width).toBe(1280)
    expect(file.height).toBe(720)
    expect(file.delivery).toBe('progressive')
  })

  /** The server sends the `uiSettings` extension that asks the *host* to draw the ad UI. */
  it('theServerAsksForHostDrawnUi', () => {
    expect(isUiHidden(ad)).toBe(true)
    expect(extensionValue(ad.extensions.find((extension) => extension.type === 'uiSettings')!, 'UiHideable')).toBe('1')
  })
})
