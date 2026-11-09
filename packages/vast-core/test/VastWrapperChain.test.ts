import { describe, expect, it } from 'vitest'
import { VastError, VastException } from '../src/VastError.js'
import { VastTagResolver, VastTagResolverFailure } from '../src/VastTagResolver.js'
import { omidResource } from '../src/VastVerification.js'
import { VastWrapperChain, type VastResourceLoader } from '../src/VastWrapperChain.js'

/**
 * A loader backed by a map, so the whole redirection chain — depth limits,
 * tracker accumulation, error reporting — runs with no network.
 */
class FixtureLoader implements VastResourceLoader {
  private readonly documents: ReadonlyMap<string, string>

  constructor(
    documents: Readonly<Record<string, string>>,
    /** URLs that should behave as unreachable. */
    private readonly unreachable: ReadonlySet<string> = new Set(),
  ) {
    this.documents = new Map(Object.entries(documents))
  }

  async loadVast(url: string, _timeoutSeconds: number): Promise<string> {
    if (this.unreachable.has(url)) throw new VastException(VastError.WRAPPER_TIMEOUT)
    const xml = this.documents.get(url)
    if (xml === undefined) throw new VastException(VastError.WRAPPER_TIMEOUT)
    return xml
  }
}

describe('VastWrapperChain', () => {
  const base = 'https://ads.test/tag.xml'

  // MARK: - Document builders

  function wrapper(
    to: string,
    error: string,
    impression: string,
    {
      clickThrough = null,
      follow = true,
      allowMultipleAds = false,
      adId = 'w',
      verificationVendor = null,
    }: {
      clickThrough?: string | null
      follow?: boolean
      allowMultipleAds?: boolean
      adId?: string
      verificationVendor?: string | null
    } = {},
  ): string {
    const click = clickThrough !== null ? `<VideoClicks><ClickThrough><![CDATA[${clickThrough}]]></ClickThrough></VideoClicks>` : ''
    const verifications =
      verificationVendor !== null
        ? `
            <AdVerifications><Verification vendor="${verificationVendor}">
              <JavaScriptResource apiFramework="omid"><![CDATA[https://${verificationVendor}/omid.js]]></JavaScriptResource>
            </Verification></AdVerifications>
            `
        : ''
    return `
            <VAST version="4.3"><Ad id="${adId}"><Wrapper followAdditionalWrappers="${follow}" allowMultipleAds="${allowMultipleAds}">
              <VASTAdTagURI><![CDATA[${to}]]></VASTAdTagURI>
              <Error><![CDATA[${error}]]></Error>
              <Impression><![CDATA[${impression}]]></Impression>
              ${verifications}
              <Creatives><Creative><Linear>
                <TrackingEvents><Tracking event="start"><![CDATA[https://ads.test/w-start]]></Tracking></TrackingEvents>
                ${click}
              </Linear></Creative></Creatives>
            </Wrapper></Ad></VAST>
        `.trim()
  }

  function inLine(clickThrough: string | null = null): string {
    const click = clickThrough !== null ? `<VideoClicks><ClickThrough><![CDATA[${clickThrough}]]></ClickThrough></VideoClicks>` : ''
    return `
            <VAST version="4.3"><Ad id="inline"><InLine>
              <AdSystem>test</AdSystem>
              <Error><![CDATA[https://ads.test/inline-error]]></Error>
              <Impression><![CDATA[https://ads.test/inline-impression]]></Impression>
              <Creatives><Creative><Linear>
                <Duration>00:00:20</Duration>
                <TrackingEvents><Tracking event="start"><![CDATA[https://ads.test/inline-start]]></Tracking></TrackingEvents>
                ${click}
                <MediaFiles><MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://ads.test/v.mp4]]></MediaFile></MediaFiles>
              </Linear></Creative></Creatives>
            </InLine></Ad></VAST>
        `.trim()
  }

  function resolve(documents: Readonly<Record<string, string>>, unreachable: ReadonlySet<string> = new Set()) {
    return new VastTagResolver(new FixtureLoader(documents, unreachable)).resolveTag(base)
  }

  async function failure(documents: Readonly<Record<string, string>>, unreachable: ReadonlySet<string> = new Set()): Promise<VastTagResolverFailure> {
    try {
      await resolve(documents, unreachable)
    } catch (error) {
      if (error instanceof VastTagResolverFailure) return error
      throw error
    }
    return expect.unreachable('expected the resolution to fail')
  }

  // MARK: - Happy path

  it('resolvesThroughTwoWrappersToInLine', async () => {
    const resolution = await resolve({
      'https://ads.test/tag.xml': wrapper('https://ads.test/w2.xml', 'https://ads.test/e1', 'https://ads.test/i1'),
      'https://ads.test/w2.xml': wrapper('https://ads.test/inline.xml', 'https://ads.test/e2', 'https://ads.test/i2'),
      'https://ads.test/inline.xml': inLine(),
    })

    expect(resolution.ads[0]!.id).toBe('inline')
    expect(resolution.chain.depth).toBe(2)
  })

  /** §2.3.5: trackers from every Wrapper in the chain accompany the InLine's own. */
  it('trackersFromEveryWrapperAreAccumulated', async () => {
    const ad = (
      await resolve({
        'https://ads.test/tag.xml': wrapper('https://ads.test/w2.xml', 'https://ads.test/e1', 'https://ads.test/i1'),
        'https://ads.test/w2.xml': wrapper('https://ads.test/inline.xml', 'https://ads.test/e2', 'https://ads.test/i2'),
        'https://ads.test/inline.xml': inLine(),
      })
    ).ads[0]!

    expect(ad.impressions.length, 'inline + two wrappers').toBe(3)
    expect(ad.errors.length).toBe(3)
    expect(ad.linear.trackingEvents.start?.length).toBe(3)
  })

  /** Flattening the chain must not lose which intermediaries served the ad. */
  it('wrapperAdIdsAreCollectedOutermostFirst', async () => {
    const ad = (
      await resolve({
        'https://ads.test/tag.xml': wrapper('https://ads.test/w2.xml', 'https://ads.test/e1', 'https://ads.test/i1', { adId: 'dsp-outer' }),
        'https://ads.test/w2.xml': wrapper('https://ads.test/inline.xml', 'https://ads.test/e2', 'https://ads.test/i2', { adId: 'ssp-inner' }),
        'https://ads.test/inline.xml': inLine(),
      })
    ).ads[0]!

    expect(ad.wrapperAdIds).toEqual(['dsp-outer', 'ssp-inner'])
    expect(ad.id, "the ad's own id is not one of its wrappers").toBe('inline')
  })

  /** A direct response crossed no wrapper, so the list is empty rather than carrying the ad's own id. */
  it('directInLineHasNoWrapperAdIds', async () => {
    expect((await resolve({ 'https://ads.test/tag.xml': inLine() })).ads[0]!.wrapperAdIds).toEqual([])
  })

  // MARK: - AdVerifications

  /** Measurement vendors are injected by intermediaries far more often than by the advertiser. */
  it('verificationsFromWrappersReachTheInLineAd', async () => {
    const ad = (
      await resolve({
        'https://ads.test/tag.xml': wrapper('https://ads.test/inline.xml', 'https://ads.test/e1', 'https://ads.test/i1', {
          verificationVendor: 'dsp-vendor',
        }),
        'https://ads.test/inline.xml': inLine(),
      })
    ).ads[0]!

    expect(ad.adVerifications.map((it) => it.vendor)).toEqual(['dsp-vendor'])
    expect(omidResource(ad.adVerifications[0]!)).not.toBeNull()
  })

  /** A duplicate verification is a second measurement session for a vendor that asked for one. */
  it('theSameVendorInjectedTwiceIsKeptOnce', async () => {
    const ad = (
      await resolve({
        'https://ads.test/tag.xml': wrapper('https://ads.test/w2.xml', 'https://ads.test/e1', 'https://ads.test/i1', {
          adId: 'w1',
          verificationVendor: 'shared-vendor',
        }),
        'https://ads.test/w2.xml': wrapper('https://ads.test/inline.xml', 'https://ads.test/e2', 'https://ads.test/i2', {
          adId: 'w2',
          verificationVendor: 'shared-vendor',
        }),
        'https://ads.test/inline.xml': inLine(),
      })
    ).ads[0]!

    expect(ad.adVerifications.length).toBe(1)
  })

  it('differentVendorsAccumulateAcrossTheChain', async () => {
    const ad = (
      await resolve({
        'https://ads.test/tag.xml': wrapper('https://ads.test/w2.xml', 'https://ads.test/e1', 'https://ads.test/i1', {
          adId: 'w1',
          verificationVendor: 'vendor-a',
        }),
        'https://ads.test/w2.xml': wrapper('https://ads.test/inline.xml', 'https://ads.test/e2', 'https://ads.test/i2', {
          adId: 'w2',
          verificationVendor: 'vendor-b',
        }),
        'https://ads.test/inline.xml': inLine(),
      })
    ).ads[0]!

    expect(ad.adVerifications.map((it) => it.vendor)).toEqual(['vendor-a', 'vendor-b'])
  })

  // MARK: - Linearity

  /** A filled slot the player cannot use is not "no fill": §2.3.6 gives it 201. */
  it('nonLinearOnlyResponseIsReportedAsUnexpectedLinearity', async () => {
    const nonLinearOnly = `
            <VAST version="4.3"><Ad id="overlay-1"><InLine>
              <AdSystem>test</AdSystem>
              <Error><![CDATA[https://ads.test/overlay-error]]></Error>
              <Impression><![CDATA[https://ads.test/overlay-impression]]></Impression>
              <Creatives><Creative><NonLinearAds>
                <NonLinear width="300" height="50">
                  <StaticResource creativeType="image/png"><![CDATA[https://ads.test/banner.png]]></StaticResource>
                </NonLinear>
              </NonLinearAds></Creative></Creatives>
            </InLine></Ad></VAST>
        `.trim()

    const failed = await failure({ 'https://ads.test/tag.xml': nonLinearOnly })
    expect(failed.error).toBe(VastError.UNEXPECTED_LINEARITY)
    expect(VastError.UNEXPECTED_LINEARITY).toBe(201)
    expect(
      failed.beacons.map((it) => it.url),
      'the server hears about it on the URI it supplied',
    ).toEqual(['https://ads.test/overlay-error'])
  })

  /** An empty response is still 303: nothing was returned to misreport. */
  it('trulyEmptyResponseIsStillNoFill', async () => {
    const empty = `<VAST version="4.3"><Error><![CDATA[https://ads.test/no-ad]]></Error></VAST>`
    expect((await failure({ 'https://ads.test/tag.xml': empty })).error).toBe(VastError.NO_VAST_RESPONSE_AFTER_WRAPPERS)
  })

  /** A relative `VASTAdTagURI` is what real responses send. */
  it('relativeTagUriIsResolvedAgainstTheFetchLocation', async () => {
    const resolution = await resolve({
      'https://ads.test/tag.xml': wrapper('next.xml', 'https://ads.test/e1', 'https://ads.test/i1'),
      'https://ads.test/next.xml': inLine(),
    })
    expect(resolution.ads[0]!.id).toBe('inline')
  })

  /** RFC 3986 §5.2.3: a base with an empty path still gets the slash before the reference. */
  it('relativeTagUriAgainstAHostWithNoPath', () => {
    expect(VastWrapperChain.resolve('next.xml', 'https://ads.test')).toBe('https://ads.test/next.xml')
    expect(VastWrapperChain.resolve('https://other.test/a.xml', 'https://ads.test/x/')).toBe('https://other.test/a.xml')
  })

  // MARK: - ClickThrough precedence

  /** §2.3.5.2: the InLine's ClickThrough must be favoured over the Wrappers'. */
  it('inLineClickThroughWinsOverWrappers', async () => {
    const ad = (
      await resolve({
        'https://ads.test/tag.xml': wrapper('https://ads.test/inline.xml', 'https://ads.test/e1', 'https://ads.test/i1', {
          clickThrough: 'https://ads.test/wrapper-landing',
        }),
        'https://ads.test/inline.xml': inLine('https://ads.test/inline-landing'),
      })
    ).ads[0]!

    expect(ad.linear.clickThrough).toBe('https://ads.test/inline-landing')
  })

  /** "the ClickThrough element closest to the InLine response must be favored" */
  it('deepestWrapperClickThroughWinsWhenInLineHasNone', async () => {
    const ad = (
      await resolve({
        'https://ads.test/tag.xml': wrapper('https://ads.test/w2.xml', 'https://ads.test/e1', 'https://ads.test/i1', {
          clickThrough: 'https://ads.test/outer',
        }),
        'https://ads.test/w2.xml': wrapper('https://ads.test/inline.xml', 'https://ads.test/e2', 'https://ads.test/i2', {
          clickThrough: 'https://ads.test/inner',
        }),
        'https://ads.test/inline.xml': inLine(),
      })
    ).ads[0]!

    expect(ad.linear.clickThrough).toBe('https://ads.test/inner')
  })

  // MARK: - Limits and failures

  /** §3.19.1 requires accepting five wrappers; the sixth is error 302. */
  it('wrapperLimitIsReportedAs302', async () => {
    const documents: Record<string, string> = {}
    for (let index = 0; index <= 8; index++) {
      documents[`https://ads.test/w${index}.xml`] = wrapper(
        `https://ads.test/w${index + 1}.xml`,
        `https://ads.test/e${index}`,
        `https://ads.test/i${index}`,
      )
    }
    documents['https://ads.test/tag.xml'] = documents['https://ads.test/w0.xml']!

    const failed = await failure(documents)
    expect(failed.error).toBe(VastError.WRAPPER_LIMIT_REACHED)
    expect(failed.error).toBe(302)
    expect(failed.beacons.length, 'every wrapper traversed is told').toBe(6)
  })

  /** §2.3.5.1: "Error codes should be sent for all wrappers in the chain." */
  it('unreachableRedirectFiresEveryWrapperError', async () => {
    const failed = await failure(
      {
        'https://ads.test/tag.xml': wrapper('https://ads.test/w2.xml', 'https://ads.test/e1', 'https://ads.test/i1'),
        'https://ads.test/w2.xml': wrapper('https://ads.test/dead.xml', 'https://ads.test/e2', 'https://ads.test/i2'),
      },
      new Set(['https://ads.test/dead.xml']),
    )
    expect(failed.error).toBe(VastError.WRAPPER_TIMEOUT)
    expect(failed.error).toBe(301)
    expect(new Set(failed.beacons.map((it) => it.url))).toEqual(new Set(['https://ads.test/e1', 'https://ads.test/e2']))
  })

  /** `followAdditionalWrappers="false"` means a Wrapper response must be ignored. */
  it('followAdditionalWrappersFalseStopsTheChain', async () => {
    const failed = await failure({
      'https://ads.test/tag.xml': wrapper('https://ads.test/w2.xml', 'https://ads.test/e1', 'https://ads.test/i1'),
      'https://ads.test/w2.xml': wrapper('https://ads.test/w3.xml', 'https://ads.test/e2', 'https://ads.test/i2', { follow: false }),
      'https://ads.test/w3.xml': inLine(),
    })
    expect(failed.error).toBe(VastError.NO_VAST_RESPONSE_AFTER_WRAPPERS)
  })

  /** §2.3.6.4: an empty response behind a wrapper is a 303, and the wrapper's own error URI still fires. */
  it('emptyResponseBehindWrapperIsReportedAs303', async () => {
    const failed = await failure({
      'https://ads.test/tag.xml': wrapper('https://ads.test/empty.xml', 'https://ads.test/e1', 'https://ads.test/i1'),
      'https://ads.test/empty.xml': `<VAST version="4.3"><Error><![CDATA[https://ads.test/no-ad]]></Error></VAST>`,
    })
    expect(failed.error).toBe(VastError.NO_VAST_RESPONSE_AFTER_WRAPPERS)
    expect(failed.error).toBe(303)
    expect(failed.beacons.some((it) => it.url === 'https://ads.test/e1')).toBe(true)
  })

  /** §3.3.1: a pod behind a wrapper gets the wrapper's trackers on every member. */
  it('podBehindWrapperGivesEveryAdTheWrapperTrackers', async () => {
    const resolution = await resolve({
      // §3.19: a wrapper must permit multiple ads for a pod to come through
      // it at all. Without this the response is reduced to one ad.
      'https://ads.test/tag.xml': wrapper('https://ads.test/pod.xml', 'https://ads.test/e1', 'https://ads.test/wrapper-impression', {
        allowMultipleAds: true,
      }),
      'https://ads.test/pod.xml': podResponse(3),
    })

    expect(resolution.ads.length).toBe(3)
    for (const ad of resolution.ads) {
      expect(ad.impressions, `${ad.id} is missing the wrapper impression`).toContain('https://ads.test/wrapper-impression')
    }
  })

  // MARK: - allowMultipleAds (§3.19)

  function podResponse(count: number, includeStandAlone = false): string {
    let sequenced = ''
    for (let index = 1; index <= count; index++) {
      sequenced += `
            <Ad id="pod-${index}" sequence="${index}"><InLine>
              <AdSystem>test</AdSystem>
              <Impression><![CDATA[https://ads.test/i-pod-${index}]]></Impression>
              <Creatives><Creative><Linear><Duration>00:00:10</Duration>
                <MediaFiles><MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://ads.test/v.mp4]]></MediaFile></MediaFiles>
              </Linear></Creative></Creatives>
            </InLine></Ad>
            `
    }
    const spare = !includeStandAlone
      ? ''
      : `
            <Ad id="spare"><InLine>
              <AdSystem>test</AdSystem>
              <Impression><![CDATA[https://ads.test/i-spare]]></Impression>
              <Creatives><Creative><Linear><Duration>00:00:10</Duration>
                <MediaFiles><MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://ads.test/v.mp4]]></MediaFile></MediaFiles>
              </Linear></Creative></Creatives>
            </InLine></Ad>
        `
    return `<VAST version="4.3">${sequenced}${spare}</VAST>`
  }

  function bareWrapper(to: string, allowMultiple: boolean | null): string {
    const attribute = allowMultiple !== null ? ` allowMultipleAds="${allowMultiple}"` : ''
    return `
            <VAST version="4.3"><Ad id="w"><Wrapper${attribute}>
              <VASTAdTagURI><![CDATA[${to}]]></VASTAdTagURI>
              <Error><![CDATA[https://ads.test/e]]></Error>
              <Impression><![CDATA[https://ads.test/i]]></Impression>
            </Wrapper></Ad></VAST>
        `.trim()
  }

  it('wrapperPermittingMultipleAdsYieldsTheWholePod', async () => {
    const resolution = await resolve({
      'https://ads.test/tag.xml': bareWrapper('https://ads.test/pod.xml', true),
      'https://ads.test/pod.xml': podResponse(3),
    })
    expect(resolution.ads.length).toBe(3)
  })

  /** Omitted means `false` (§3.19), so the same response yields one ad. */
  it('wrapperWithoutTheAttributeAllowsOnlyOneAd', async () => {
    const resolution = await resolve({
      'https://ads.test/tag.xml': bareWrapper('https://ads.test/pod.xml', null),
      'https://ads.test/pod.xml': podResponse(3),
    })
    expect(resolution.ads.length, 'the default is false, not true').toBe(1)
  })

  /** "only the first stand-alone Ad (with no sequence values) ... is allowed". */
  it('standAloneAdIsPreferredWhenMultipleAdsAreNotAllowed', async () => {
    const resolution = await resolve({
      'https://ads.test/tag.xml': bareWrapper('https://ads.test/pod.xml', false),
      'https://ads.test/pod.xml': podResponse(2, true),
    })
    expect(resolution.ads.map((it) => it.id)).toEqual(['spare'])
  })

  /** A direct response has no wrapper imposing the constraint. */
  it('directResponseIsNotConstrained', async () => {
    expect((await resolve({ 'https://ads.test/tag.xml': podResponse(3) })).ads.length, 'there is no wrapper at depth zero').toBe(3)
  })
})
