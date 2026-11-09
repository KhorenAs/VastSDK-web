import { describe, expect, it } from 'vitest'
import { VastTagResolver, VastTagResolverFailure } from '../src/VastTagResolver.js'
import type { VastResourceLoader } from '../src/VastWrapperChain.js'
import { lastPathComponent } from './support.js'

/**
 * Both ways in have to behave the same. Starting the tail of the chain over in
 * `resolveXml` would quietly lose everything the document it was handed had
 * collected — and a host holding XML rather than a URL would have no way to know.
 */
describe('VastTagResolver', () => {
  const host = (url: string): string | null => {
    try {
      return new URL(url).host
    } catch {
      return null
    }
  }

  // MARK: - The chain carries on

  /** The same wrapper, down each path, has to yield the same trackers. */
  it('handingInAWrapperCollectsAsMuchAsFetchingIt', async () => {
    const r = resolver()

    const fromFetch = (await r.resolveTag(OUTER_URL)).ads[0]!
    const fromHandIn = (await r.resolveXml(WRAPPER, OUTER_URL)).ads[0]!

    expect(new Set(fromHandIn.impressions.map(host)), "the wrapper's own <Impression> was dropped").toEqual(
      new Set(fromFetch.impressions.map(host)),
    )
    expect(
      new Set(fromHandIn.errors.map(host)),
      "the wrapper's own <Error> was dropped, so a failure would go unreported",
    ).toEqual(new Set(fromFetch.errors.map(host)))
    expect(fromHandIn.wrapperAdIds, 'the intermediary that served the ad was forgotten').toEqual(fromFetch.wrapperAdIds)
  })

  it('theOuterWrapperContributesItsOwnTrackers', async () => {
    const ad = (await resolver().resolveXml(WRAPPER, OUTER_URL)).ads[0]!

    expect(ad.impressions.some((url) => host(url) === 'outer.example')).toBe(true)
    expect(ad.errors.some((url) => host(url) === 'outer.example')).toBe(true)
    expect(ad.wrapperAdIds).toEqual(['outer'])
  })

  /** Starting the tail over would make the real limit twice `maxDepth`. */
  it('depthIsNotRestartedForTheTail', async () => {
    expect((await resolver().resolveXml(WRAPPER, OUTER_URL)).chain.depth, 'the hop this document itself made was forgotten').toBe(1)
  })

  // MARK: - What the chain must not lose

  /** These are the fields a reporting pipeline needs, so losing them is invisible until a report is empty. */
  it('theChainCarriesTheInLinesOwnMetadata', async () => {
    const ad = (await resolver(RICH_IN_LINE).resolveTag(OUTER_URL)).ads[0]!

    expect(ad.adServingId).toBe('serving-1')
    expect(ad.universalAdIds[0]!.value).toBe('CNPA0484000H')
    expect(ad.advertiser).toBe('Kinodaran')
    expect(ad.icons.length).toBe(1)
    expect(ad.linear.customClicks.map(lastPathComponent)).toEqual(['custom'])
  })

  /** A Wrapper may ask about viewability on its own account (§3.6), and both sets of URIs survive. */
  it('bothTheWrapperAndTheInLineAreHeardAboutViewability', async () => {
    const asked = (await resolver(RICH_IN_LINE).resolveTag(OUTER_URL)).ads[0]!.viewableImpression
    expect(asked).not.toBeNull()
    expect(new Set(asked!.viewUndetermined.map(host))).toEqual(new Set(['inner.example', 'outer.example']))
  })

  // MARK: - Cancellation

  /** Leaving is not a failed redirect: a cancelled resolution reports nothing to anyone. */
  it('cancellationIsNotReportedAsATimeout', async () => {
    const cancelling: VastResourceLoader = {
      loadVast: async () => {
        const error = new Error('left')
        error.name = 'AbortError'
        throw error
      },
    }
    const failure = await new VastTagResolver(cancelling).resolveTag(OUTER_URL).catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(VastTagResolverFailure)
    expect((failure as Error).name).toBe('AbortError')
  })

  /**
   * The web's cancellation arrives as an aborted signal rather than a thrown
   * exception, and a loader may not look at it. The resolver does.
   */
  it('anAbortedSignalStopsTheChainWithoutReportingIt', async () => {
    const controller = new AbortController()
    const ignoring: VastResourceLoader = {
      loadVast: async (url) => {
        controller.abort()
        return url === OUTER_URL ? WRAPPER : IN_LINE
      },
    }
    const failure = await new VastTagResolver(ignoring)
      .resolveTag(OUTER_URL, controller.signal)
      .catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(VastTagResolverFailure)
    expect((failure as Error).name).toBe('AbortError')
  })

  // MARK: - Fixtures

  function resolver(inLine: string | null = null): VastTagResolver {
    return new VastTagResolver(new FixtureLoader({ [OUTER_URL]: WRAPPER, [INNER_URL]: inLine ?? IN_LINE }))
  }
})

class FixtureLoader implements VastResourceLoader {
  constructor(private readonly documents: Readonly<Record<string, string>>) {}

  async loadVast(url: string): Promise<string> {
    const xml = this.documents[url]
    if (xml === undefined) throw new Error(`unreachable: ${url}`)
    return xml
  }
}

const OUTER_URL = 'https://outer.example/vast.xml'
const INNER_URL = 'https://inner.example/vast.xml'

const WRAPPER = `<VAST version="4.0"><Ad id="outer"><Wrapper>
  <AdSystem>outer</AdSystem>
  <Impression><![CDATA[https://outer.example/impression]]></Impression>
  <Error><![CDATA[https://outer.example/error]]></Error>
  <VASTAdTagURI><![CDATA[https://inner.example/vast.xml]]></VASTAdTagURI>
  <ViewableImpression>
    <ViewUndetermined><![CDATA[https://outer.example/undetermined]]></ViewUndetermined>
  </ViewableImpression>
  <Creatives><Creative><Linear><TrackingEvents>
    <Tracking event="start"><![CDATA[https://outer.example/start]]></Tracking>
  </TrackingEvents></Linear></Creative></Creatives>
</Wrapper></Ad></VAST>`

const IN_LINE = `<VAST version="4.0"><Ad id="inner"><InLine>
  <AdSystem>inner</AdSystem>
  <Impression><![CDATA[https://inner.example/impression]]></Impression>
  <Creatives><Creative><Linear>
    <Duration>00:00:15</Duration>
    <MediaFiles>
      <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://inner.example/a.mp4]]></MediaFile>
    </MediaFiles>
  </Linear></Creative></Creatives>
</InLine></Ad></VAST>`

/** An InLine carrying the VAST 4 fields a reporting pipeline reads. */
const RICH_IN_LINE = `<VAST version="4.3"><Ad id="inner"><InLine>
  <AdSystem>inner</AdSystem>
  <AdServingId>serving-1</AdServingId>
  <Advertiser>Kinodaran</Advertiser>
  <Impression><![CDATA[https://inner.example/impression]]></Impression>
  <ViewableImpression>
    <ViewUndetermined><![CDATA[https://inner.example/undetermined]]></ViewUndetermined>
  </ViewableImpression>
  <Creatives><Creative>
    <UniversalAdId idRegistry="Ad-ID">CNPA0484000H</UniversalAdId>
    <Icons><Icon program="AdChoices">
      <StaticResource creativeType="image/png"><![CDATA[https://inner.example/i.png]]></StaticResource>
    </Icon></Icons>
    <Linear>
      <Duration>00:00:15</Duration>
      <VideoClicks>
        <CustomClick><![CDATA[https://inner.example/custom]]></CustomClick>
      </VideoClicks>
      <MediaFiles>
        <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://inner.example/a.mp4]]></MediaFile>
      </MediaFiles>
    </Linear>
  </Creative></Creatives>
</InLine></Ad></VAST>`
