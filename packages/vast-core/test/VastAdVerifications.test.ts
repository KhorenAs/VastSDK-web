import { describe, expect, it } from 'vitest'
import type { VastAd } from '../src/VastAd.js'
import type { VastBeacon } from '../src/VastBeacon.js'
import { VastMacroExpander } from '../src/VastMacroExpander.js'
import { VastTrackingEngine } from '../src/VastTrackingEngine.js'
import { omidResource, VastNotExecutedReason } from '../src/VastVerification.js'
import { firstAd } from './support.js'

/**
 * `<AdVerifications>` moved between VAST 3 and VAST 4, and ad servers still send
 * both shapes. A host asks for `adVerifications` and should not have to know
 * which version answered.
 */
describe('VastAdVerifications', () => {
  /** The body of an InLine, with whatever verification markup a test supplies. */
  function inLine({ version = '4.3', verifications }: { version?: string; verifications: string }): string {
    return trimIndent(`
        <?xml version="1.0" encoding="UTF-8"?>
        <VAST version="${version}">
          <Ad id="a1"><InLine>
            <AdSystem>test</AdSystem>
            <Impression><![CDATA[https://ads.test/impression]]></Impression>
            <Creatives><Creative><Linear>
              <Duration>00:00:30</Duration>
              <TrackingEvents>
                <Tracking event="start"><![CDATA[https://ads.test/start]]></Tracking>
                <Tracking event="complete"><![CDATA[https://ads.test/complete]]></Tracking>
              </TrackingEvents>
              <MediaFiles>
                <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://ads.test/v.mp4]]></MediaFile>
              </MediaFiles>
            </Linear></Creative></Creatives>
            ${verifications}
          </InLine></Ad>
        </VAST>
    `)
  }

  // MARK: - VAST 4

  it('parsesVast4AdVerifications', () => {
    const ad = firstAd(
      inLine({
        verifications: `
                <AdVerifications>
                  <Verification vendor="measure.com-omid">
                    <JavaScriptResource apiFramework="omid" browserOptional="true">
                      <![CDATA[https://measure.com/omid.js]]>
                    </JavaScriptResource>
                    <VerificationParameters><![CDATA[{"key":"abc123"}]]></VerificationParameters>
                    <TrackingEvents>
                      <Tracking event="verificationNotExecuted"><![CDATA[https://measure.com/not-executed]]></Tracking>
                    </TrackingEvents>
                  </Verification>
                </AdVerifications>
                `,
      }),
    )

    // `single()` in the Kotlin.
    expect(ad.adVerifications).toHaveLength(1)
    const verification = ad.adVerifications[0]!
    expect(verification.vendor).toBe('measure.com-omid')
    expect(verification.parameters).toBe('{"key":"abc123"}')
    expect(verification.notExecutedTrackers).toEqual(['https://measure.com/not-executed'])

    const resource = omidResource(verification)
    expect(resource).not.toBeNull()
    expect(resource!.url).toBe('https://measure.com/omid.js')
    expect(resource!.kind).toBe('javaScript')
    expect(resource!.browserOptional).toBe(true)
  })

  // MARK: - VAST 3

  /**
   * VAST 3 had no element for this, so vendors shipped the same content inside
   * `<Extension type="AdVerifications">`. It must normalise to the same model.
   */
  it('parsesVast3ExtensionShapeIdentically', () => {
    const ad = firstAd(
      inLine({
        version: '3.0',
        verifications: `
                <Extensions>
                  <Extension type="AdVerifications">
                    <AdVerifications>
                      <Verification vendor="measure.com-omid">
                        <JavaScriptResource apiFramework="omid" browserOptional="true">
                          <![CDATA[https://measure.com/omid.js]]>
                        </JavaScriptResource>
                        <VerificationParameters><![CDATA[{"key":"abc123"}]]></VerificationParameters>
                        <TrackingEvents>
                          <Tracking event="verificationNotExecuted"><![CDATA[https://measure.com/not-executed]]></Tracking>
                        </TrackingEvents>
                      </Verification>
                    </AdVerifications>
                  </Extension>
                </Extensions>
                `,
      }),
    )

    const verification = ad.adVerifications[0]!
    expect(verification.vendor).toBe('measure.com-omid')
    expect(omidResource(verification)?.url).toBe('https://measure.com/omid.js')
    expect(verification.parameters).toBe('{"key":"abc123"}')
    expect(verification.notExecutedTrackers.length).toBe(1)
  })

  /** Some servers omit the inner `<AdVerifications>` and put `<Verification>` straight into the extension. */
  it('parsesVast3ExtensionWithoutTheInnerWrapper', () => {
    const ad = firstAd(
      inLine({
        version: '3.0',
        verifications: `
                <Extensions>
                  <Extension type="adverifications">
                    <Verification vendor="terse.com">
                      <JavaScriptResource apiFramework="omid"><![CDATA[https://terse.com/v.js]]></JavaScriptResource>
                    </Verification>
                  </Extension>
                </Extensions>
                `,
      }),
    )

    expect(ad.adVerifications[0]!.vendor, "the type attribute's case is not ours to police").toBe('terse.com')
  })

  /** Normalised, not duplicated: the same content must not also surface as a raw extension. */
  it('verificationExtensionIsNotAlsoReportedRaw', () => {
    const ad = firstAd(
      inLine({
        version: '3.0',
        verifications: `
                <Extensions>
                  <Extension type="AdVerifications">
                    <AdVerifications>
                      <Verification vendor="measure.com">
                        <JavaScriptResource apiFramework="omid"><![CDATA[https://measure.com/v.js]]></JavaScriptResource>
                      </Verification>
                    </AdVerifications>
                  </Extension>
                  <Extension type="uiSettings"><UiHideable>1</UiHideable></Extension>
                </Extensions>
                `,
      }),
    )

    expect(ad.adVerifications.length).toBe(1)
    expect(
      ad.extensions.map((extension) => extension.type).filter((type): type is string => type !== null),
      'other extensions are untouched',
    ).toEqual(['uiSettings'])
  })

  // MARK: - Scope

  /**
   * `<TrackingEvents>` lives under both `<Linear>` and `<Verification>`. Filing a
   * verification's tracker as a creative event loses it twice over.
   */
  it('verificationTrackerDoesNotLeakIntoCreativeEvents', () => {
    const ad = firstAd(
      inLine({
        verifications: `
                <AdVerifications>
                  <Verification vendor="measure.com">
                    <JavaScriptResource apiFramework="omid"><![CDATA[https://measure.com/v.js]]></JavaScriptResource>
                    <TrackingEvents>
                      <Tracking event="verificationNotExecuted"><![CDATA[https://measure.com/not-executed]]></Tracking>
                    </TrackingEvents>
                  </Verification>
                </AdVerifications>
                `,
      }),
    )

    expect(ad.linear.trackingEvents.start?.length).toBe(1)
    expect(ad.linear.trackingEvents.complete?.length).toBe(1)
    expect(Object.keys(ad.linear.trackingEvents).length, 'no third event arrived from the verification').toBe(2)
    expect(ad.adVerifications[0]!.notExecutedTrackers.length).toBe(1)
  })

  // MARK: - Resources

  /** An executable resource cannot run here, but the vendor still expects to hear why. */
  it('executableOnlyVerificationIsKeptButUnusable', () => {
    const ad = firstAd(
      inLine({
        verifications: `
                <AdVerifications>
                  <Verification vendor="native.com">
                    <ExecutableResource apiFramework="native" type="binary">
                      <![CDATA[https://native.com/lib.bin]]>
                    </ExecutableResource>
                    <TrackingEvents>
                      <Tracking event="verificationNotExecuted"><![CDATA[https://native.com/not-executed]]></Tracking>
                    </TrackingEvents>
                  </Verification>
                </AdVerifications>
                `,
      }),
    )

    const verification = ad.adVerifications[0]!
    expect(omidResource(verification), 'reason 1, not reason 3').toBeNull()
    expect(verification.resources[0]!.kind).toBe('executable')
    expect(verification.resources[0]!.type).toBe('binary')
    expect(verification.notExecutedTrackers.length).toBe(1)
  })

  /** A JavaScript resource for someone else's framework is not an OMID resource. */
  it('nonOmidJavaScriptIsNotOfferedAsOmid', () => {
    const ad = firstAd(
      inLine({
        verifications: `
                <AdVerifications>
                  <Verification vendor="other.com">
                    <JavaScriptResource apiFramework="spatial"><![CDATA[https://other.com/v.js]]></JavaScriptResource>
                  </Verification>
                </AdVerifications>
                `,
      }),
    )

    const verification = ad.adVerifications[0]!
    expect(omidResource(verification)).toBeNull()
    expect(verification.resources.length).toBe(1)
  })

  /** `browserOptional` defaults to false (§3.16), and `omid` arrives in mixed case often enough. */
  it('defaultsAndCaseInsensitiveFramework', () => {
    const ad = firstAd(
      inLine({
        verifications: `
                <AdVerifications>
                  <Verification vendor="mixed.com">
                    <JavaScriptResource apiFramework="OMID"><![CDATA[https://mixed.com/v.js]]></JavaScriptResource>
                  </Verification>
                </AdVerifications>
                `,
      }),
    )

    const resource = omidResource(ad.adVerifications[0]!)
    expect(resource).not.toBeNull()
    expect(resource!.browserOptional).toBe(false)
  })

  /** A `<Verification>` asking for nothing is not something to report on. */
  it('verificationWithoutResourcesIsDropped', () => {
    const ad = firstAd(
      inLine({ verifications: '<AdVerifications><Verification vendor="empty.com"></Verification></AdVerifications>' }),
    )
    expect(ad.adVerifications.length === 0).toBe(true)
  })

  /** Several vendors on one ad is the ordinary case, not an edge case. */
  it('multipleVendorsAreAllKept', () => {
    const ad = firstAd(
      inLine({
        verifications: `
                <AdVerifications>
                  <Verification vendor="one.com">
                    <JavaScriptResource apiFramework="omid"><![CDATA[https://one.com/v.js]]></JavaScriptResource>
                  </Verification>
                  <Verification vendor="two.com">
                    <JavaScriptResource apiFramework="omid"><![CDATA[https://two.com/v.js]]></JavaScriptResource>
                  </Verification>
                </AdVerifications>
                `,
      }),
    )

    expect(ad.adVerifications.map((verification) => verification.vendor)).toEqual(['one.com', 'two.com'])
  })

  it('adWithoutVerificationsHasAnEmptyList', () => {
    expect(firstAd(inLine({ verifications: '' })).adVerifications.length === 0).toBe(true)
  })

  // MARK: - Reporting

  function beacons(ad: VastAd, measurementWillRun = false): VastBeacon[] {
    return new VastTrackingEngine(ad, null, measurementWillRun).advance({
      adTime: 0.0,
      duration: 30.0,
      rate: 1,
      wallClock: 0.0,
    })
  }

  function reasons(fired: readonly VastBeacon[]): VastNotExecutedReason[] {
    const out: VastNotExecutedReason[] = []
    for (const beacon of fired) {
      if (beacon.kind.type === 'verificationNotExecuted') out.push(beacon.kind.reason)
    }
    return out
  }

  /** Reason 3: there was a usable resource and nothing was asked to run it. */
  it('usableResourceWithNoMeasurementReportsNotExecuted', () => {
    const ad = firstAd(
      inLine({
        verifications: `
                <AdVerifications>
                  <Verification vendor="measure.com">
                    <JavaScriptResource apiFramework="omid"><![CDATA[https://measure.com/v.js]]></JavaScriptResource>
                    <TrackingEvents>
                      <Tracking event="verificationNotExecuted"><![CDATA[https://measure.com/ne?r=[REASON]]]></Tracking>
                    </TrackingEvents>
                  </Verification>
                </AdVerifications>
                `,
      }),
    )

    expect(reasons(beacons(ad))).toEqual([VastNotExecutedReason.NOT_EXECUTED])
  })

  /** Reason 1: nothing here could ever have run, measurement or not. */
  it('executableOnlyResourceReportsResourceNotSupported', () => {
    const ad = firstAd(
      inLine({
        verifications: `
                <AdVerifications>
                  <Verification vendor="native.com">
                    <ExecutableResource apiFramework="native"><![CDATA[https://native.com/lib.bin]]></ExecutableResource>
                    <TrackingEvents>
                      <Tracking event="verificationNotExecuted"><![CDATA[https://native.com/ne]]></Tracking>
                    </TrackingEvents>
                  </Verification>
                </AdVerifications>
                `,
      }),
    )

    expect(reasons(beacons(ad))).toEqual([VastNotExecutedReason.RESOURCE_NOT_SUPPORTED])
  })

  /** A host that does run them owes nothing — reporting anyway would contradict the vendor's own data. */
  it('nothingIsReportedWhenMeasurementWillRun', () => {
    const ad = firstAd(
      inLine({
        verifications: `
                <AdVerifications>
                  <Verification vendor="measure.com">
                    <JavaScriptResource apiFramework="omid"><![CDATA[https://measure.com/v.js]]></JavaScriptResource>
                    <TrackingEvents>
                      <Tracking event="verificationNotExecuted"><![CDATA[https://measure.com/ne]]></Tracking>
                    </TrackingEvents>
                  </Verification>
                </AdVerifications>
                `,
      }),
    )

    expect(reasons(beacons(ad, true)).length === 0).toBe(true)
  })

  /** `[REASON]` is what tells the vendor *why*; sent literally it says nothing. */
  it('reasonMacroExpandsToTheReportedCode', () => {
    const expanded = new VastMacroExpander().expandUrl('https://measure.com/ne?r=%5BREASON%5D', {
      verificationNotExecutedReason: VastNotExecutedReason.NOT_EXECUTED,
    })
    expect(expanded).toBe('https://measure.com/ne?r=3')
  })

  it('reasonMacroIsUnknownOnOtherBeacons', () => {
    expect(new VastMacroExpander().expandUrl('https://ads.test/e?r=%5BREASON%5D', {})).toBe('https://ads.test/e?r=-1')
  })

  it('verificationVendorsMacroListsTheVendors', () => {
    const expanded = new VastMacroExpander().expandUrl('https://ads.test/t?v=%5BVERIFICATIONVENDORS%5D', {
      verificationVendors: ['one.com-omid', 'two.com'],
    })
    expect(expanded).toBe('https://ads.test/t?v=one.com-omid%2Ctwo.com')
  })

  it('verificationVendorsMacroIsUnknownWhenNoneWereNamed', () => {
    expect(new VastMacroExpander().expandUrl('https://ads.test/t?v=%5BVERIFICATIONVENDORS%5D', {})).toBe(
      'https://ads.test/t?v=-1',
    )
  })

  it('omidPartnerMacro', () => {
    const url = 'https://ads.test/t?p=%5BOMIDPARTNER%5D'
    expect(new VastMacroExpander().expandUrl(url, { omidPartner: 'Kinodaran/1.0' })).toBe(
      'https://ads.test/t?p=Kinodaran%2F1.0',
    )
    expect(new VastMacroExpander().expandUrl(url, {})).toBe('https://ads.test/t?p=-1')
  })
})

/**
 * Kotlin's `trimIndent()`, so each document is the one the Kotlin test parses —
 * which matters here, because an XML declaration has to open the document.
 */
function trimIndent(text: string): string {
  const lines = text.split('\n')
  const indent = Math.min(...lines.filter((line) => line.trim().length > 0).map((line) => line.search(/\S/)))
  return lines
    .filter((line, index) => !((index === 0 || index === lines.length - 1) && line.trim().length === 0))
    .map((line) => line.slice(indent))
    .join('\n')
}
