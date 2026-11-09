import { describe, expect, it } from 'vitest'
import type { VastAd } from '../src/VastAd.js'
import { VastParser } from '../src/VastParser.js'
import { VastTrackingEngine } from '../src/VastTrackingEngine.js'
import { firstAd, fixture, inLine, lastPathComponent } from './support.js'

/**
 * The VAST 4 elements a reporting pipeline needs. Two of them the specification
 * makes required, and skipping those would leave the most useful fields in a
 * response on the floor.
 */
describe('VastMetadata', () => {
  // MARK: - Identity

  it('theIdentifiersBothSidesQuoteAreParsed', () => {
    const parsed = ad({
      inLine: '<AdServingId>c8b7d3a1-2f4e</AdServingId><Advertiser>Kinodaran</Advertiser>',
      creative: '<UniversalAdId idRegistry="Ad-ID">CNPA0484000H</UniversalAdId>',
    })

    expect(parsed.adServingId).toBe('c8b7d3a1-2f4e')
    expect(parsed.advertiser).toBe('Kinodaran')
    expect(parsed.universalAdIds).toEqual([{ registry: 'Ad-ID', value: 'CNPA0484000H' }])
  })

  /** `unknown` is a registry some servers really send, and it is a different fact from having sent nothing. */
  it('anUnknownRegistryIsStillARegistry', () => {
    const parsed = ad({ creative: '<UniversalAdId idRegistry="unknown">abc123</UniversalAdId>' })
    expect(parsed.universalAdIds[0]!.registry).toBe('unknown')
  })

  it('pricingAndCategoriesAreParsed', () => {
    const parsed = ad({
      inLine: `
            <Pricing model="CPM" currency="USD">12.50</Pricing>
            <Category authority="https://iabtechlab.com/categories">IAB1-1</Category>
            <Expires>3600</Expires>
            `,
    })

    expect(parsed.pricing).toEqual({ model: 'CPM', currency: 'USD', value: 12.5 })
    expect(parsed.categories).toEqual([{ authority: 'https://iabtechlab.com/categories', code: 'IAB1-1' }])
    // Plain seconds, unlike <Duration>'s timecode.
    expect(parsed.expires).toBe(3600.0)
  })

  // MARK: - Viewability

  it('allThreeViewabilityOutcomesAreParsed', () => {
    const parsed = ad({
      inLine: `
            <ViewableImpression id="vi-1">
              <Viewable><![CDATA[https://ads.test/viewable]]></Viewable>
              <NotViewable><![CDATA[https://ads.test/not-viewable]]></NotViewable>
              <ViewUndetermined><![CDATA[https://ads.test/undetermined]]></ViewUndetermined>
            </ViewableImpression>
            `,
    })

    const asked = parsed.viewableImpression
    expect(asked).not.toBeNull()
    expect(asked!.id).toBe('vi-1')
    expect(asked!.viewable.map(lastPathComponent)).toEqual(['viewable'])
    expect(asked!.notViewable.map(lastPathComponent)).toEqual(['not-viewable'])
    expect(asked!.viewUndetermined.map(lastPathComponent)).toEqual(['undetermined'])
  })

  /** An element that asked for nothing is nothing. */
  it('anEmptyViewableImpressionIsDropped', () => {
    expect(ad({ inLine: '<ViewableImpression id="vi-1"></ViewableImpression>' }).viewableImpression).toBeNull()
  })

  /** The only outcome this player can honestly claim, and it goes out with the impression. */
  it('viewUndeterminedIsReportedWhenNothingCanMeasure', () => {
    const parsed = ad({
      inLine: `
            <ViewableImpression>
              <Viewable><![CDATA[https://ads.test/viewable]]></Viewable>
              <ViewUndetermined><![CDATA[https://ads.test/undetermined]]></ViewUndetermined>
            </ViewableImpression>
            `,
    })
    const fired = new VastTrackingEngine(parsed, 20.0, false).advance({ adTime: 0.0, duration: 20.0, rate: 1, wallClock: 0.0 })

    expect(
      fired.some((beacon) => beacon.kind.type === 'viewUndetermined'),
      'the response asked about viewability and heard nothing back',
    ).toBe(true)
    expect(
      fired.some((beacon) => lastPathComponent(beacon.url) === 'viewable'),
      'a player that cannot measure viewability must not claim it',
    ).toBe(false)
  })

  /** With measurement in place the answer is the adapter's to give, not the engine's to pre-empt. */
  it('viewUndeterminedIsSilentWhenSomethingWillMeasure', () => {
    const parsed = ad({
      inLine: '<ViewableImpression><ViewUndetermined><![CDATA[https://ads.test/undetermined]]></ViewUndetermined></ViewableImpression>',
    })
    const fired = new VastTrackingEngine(parsed, 20.0, true).advance({ adTime: 0.0, duration: 20.0, rate: 1, wallClock: 0.0 })

    expect(fired.some((beacon) => beacon.kind.type === 'viewUndetermined')).toBe(false)
  })

  // MARK: - Icons

  /** From the live AdFox tag, which is where the empty `width=""` comes from — an empty attribute is not a zero. */
  it('theIconFromARealTagIsParsed', () => {
    const parsed = inLine(new VastParser().parse(fixture('legacy-events')).entries[0])

    const icon = parsed.icons[0]!
    expect(icon.program).toBe('IconTopLeft')
    expect(icon.xPosition).toBe('left')
    expect(icon.yPosition).toBe('top')
    expect(icon.offset).toBe(0.0)
    expect(icon.width, 'width="" is not a width of zero').toBeNull()
    expect(icon.staticResource === null ? null : lastPathComponent(icon.staticResource)).toBe('icon.png')
    expect(icon.staticResourceType).toBe('image/png')
    expect(icon.clickThrough === null ? null : lastPathComponent(icon.clickThrough)).toBe('icon-landing')
  })

  /** An icon with no image is dropped: a host cannot draw an absent resource. */
  it('anIconWithNothingToDrawIsDropped', () => {
    expect(
      ad({ creative: '<Icons><Icon program="AdChoices" xPosition="right" yPosition="top"/></Icons>' }).icons.length === 0,
    ).toBe(true)
  })

  it('anIconDoesNotDisturbTheCreativeAroundIt', () => {
    const parsed = ad({
      creative: `
            <Icons><Icon program="AdChoices">
              <StaticResource creativeType="image/png"><![CDATA[https://ads.test/i.png]]></StaticResource>
            </Icon></Icons>
            `,
    })
    expect(parsed.linear.mediaFiles.length).toBe(1)
    expect(parsed.linear.duration).toBe(20.0)
    expect(parsed.icons.length).toBe(1)
  })

  // MARK: - Custom clicks

  /** `<CustomClick>` is not `<ClickTracking>`: one accompanies a destination and the other opens nothing. */
  it('customClicksAreKeptApartFromClickTracking', () => {
    const parsed = ad({
      creative: `
            <VideoClicks>
              <ClickThrough><![CDATA[https://ads.test/landing]]></ClickThrough>
              <ClickTracking><![CDATA[https://ads.test/click]]></ClickTracking>
              <CustomClick><![CDATA[https://ads.test/custom]]></CustomClick>
            </VideoClicks>
            `,
    })

    expect(parsed.linear.clickTracking.map(lastPathComponent)).toEqual(['click'])
    expect(parsed.linear.customClicks.map(lastPathComponent)).toEqual(['custom'])
  })

  it('reportingACustomClickFiresOnlyItsOwnUris', () => {
    const parsed = ad({
      creative: `
            <VideoClicks>
              <ClickTracking><![CDATA[https://ads.test/click]]></ClickTracking>
              <CustomClick><![CDATA[https://ads.test/custom]]></CustomClick>
            </VideoClicks>
            `,
    })
    const engine = new VastTrackingEngine(parsed, 20.0)
    engine.advance({ adTime: 0.0, duration: 20.0, rate: 1, wallClock: 0.0 })

    const fired = engine.reportCustomClick()
    expect(fired.map((beacon) => lastPathComponent(beacon.url))).toEqual(['custom'])
    expect(fired[0]!.kind).toEqual({ type: 'customClick' })
  })

  // MARK: - Fixtures

  function ad({ inLine = '', creative = '' }: { inLine?: string; creative?: string } = {}): VastAd {
    return firstAd(
      trimIndent(`
        <VAST version="4.3"><Ad id="a"><InLine>
          <AdSystem>test</AdSystem>
          <Impression><![CDATA[https://ads.test/impression]]></Impression>
          ${inLine}
          <Creatives><Creative>
            ${creative}
            <Linear>
              <Duration>00:00:20</Duration>
              <MediaFiles>
                <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://ads.test/v.mp4]]></MediaFile>
              </MediaFiles>
            </Linear>
          </Creative></Creatives>
        </InLine></Ad></VAST>
        `),
    )
  }
})

/** Kotlin's `trimIndent()`, so each document is the one the Kotlin test parses. */
function trimIndent(text: string): string {
  const lines = text.split('\n')
  const indent = Math.min(...lines.filter((line) => line.trim().length > 0).map((line) => line.search(/\S/)))
  return lines
    .filter((line, index) => !((index === 0 || index === lines.length - 1) && line.trim().length === 0))
    .map((line) => line.slice(indent))
    .join('\n')
}
