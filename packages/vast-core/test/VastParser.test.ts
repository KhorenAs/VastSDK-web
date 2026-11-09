import { describe, expect, it } from 'vitest'
import { extensionValue, isSkippable, resolvedSkipOffset } from '../src/VastAd.js'
import { isNoAd } from '../src/VastDocument.js'
import { VastError, VastException } from '../src/VastError.js'
import { VastParser } from '../src/VastParser.js'
import { firstAd, fixture, inLine, wrapper } from './support.js'

describe('VastParser', () => {
  const parser = new VastParser()

  // MARK: - InLine

  it('parsesInLineLinear', () => {
    const document = parser.parse(fixture('inline-linear'))
    expect(document.version).toBe('4.3')
    expect(document.entries.length).toBe(1)

    const ad = inLine(document.entries[0])
    expect(ad.id).toBe('20001')
    expect(ad.linear.duration).toBe(16.0)
    expect(ad.linear.mediaFiles.length).toBe(1)
    expect(ad.impressions.length).toBe(1)
    expect(new Set(Object.keys(ad.linear.trackingEvents))).toEqual(
      new Set(['start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete']),
    )
  })

  /**
   * The same document writes some URIs bare and others in CDATA. Both paths
   * arrive through different callbacks and must produce equal URLs.
   */
  it('readsUrisFromBothPlainTextAndCdata', () => {
    const ad = inLine(parser.parse(fixture('inline-linear')).entries[0])

    // <Error>http://example.com/error</Error> — no CDATA
    expect(ad.errors[0]).toBe('http://example.com/error')
    // <MediaFile><![CDATA[ ... ]]></MediaFile> — CDATA, padded with newlines
    const media = ad.linear.mediaFiles[0]!
    expect(media.url.startsWith('https://')).toBe(true)
    expect(media.url.includes('\n')).toBe(false)
  })

  /** VAST booleans appear as `1`/`0` in practice, not only `true`/`false`. */
  it('parsesNumericBooleanAttributes', () => {
    const media = inLine(parser.parse(fixture('inline-linear')).entries[0]).linear.mediaFiles[0]!

    expect(media.scalable).toBe(true) // scalable="1"
    expect(media.maintainAspectRatio).toBe(true) // maintainAspectRatio="1"
    expect(media.bitrate).toBe(500)
    expect(media.minBitrate).toBe(360)
    expect(media.maxBitrate).toBe(1080)
    expect(media.delivery).toBe('progressive')
  })

  it('capturesExtensionsWithoutInterpretingThem', () => {
    const ad = inLine(parser.parse(fixture('inline-linear')).entries[0])
    expect(ad.extensions.length > 0).toBe(true)
    expect(ad.extensions[0]!.xml.length > 0).toBe(true)
  })

  /**
   * Reading a vendor key should not mean writing a string scanner in every host
   * — but the SDK still assigns the value no meaning.
   */
  it('extensionValueReadsAChildElement', () => {
    expect(extensionValue({ type: 'uiSettings', xml: '<UiHideable>1</UiHideable>' }, 'UiHideable')).toBe('1')
    expect(
      extensionValue({ type: 'uiSettings', xml: '<UiHideable><![CDATA[0]]></UiHideable>' }, 'UiHideable'),
      'servers wrap in CDATA about as often as not',
    ).toBe('0')
    expect(extensionValue({ type: 'uiSettings', xml: '<UiHideable mode="strict"> 1 </UiHideable>' }, 'UiHideable')).toBe(
      '1',
    )
  })

  /** Absent and present-but-empty are different facts, and a host acting on the key needs to tell them apart. */
  it('extensionValueDistinguishesAbsentFromEmpty', () => {
    const extension = { type: 'uiSettings', xml: '<UiHideable></UiHideable><Skin/>' }
    expect(extensionValue(extension, 'UiHideable')).toBe('')
    expect(extensionValue(extension, 'Skin'), 'self-closing carries no text').toBe('')
    expect(extensionValue(extension, 'Missing')).toBeNull()
  })

  // MARK: - Wrapper

  it('parsesWrapperAndItsAttributes', () => {
    const parsed = wrapper(parser.parse(fixture('wrapper-a')).entries[0])

    expect(parsed.tagUri).toBe('wrapper-b.xml')
    expect(parsed.followAdditionalWrappers, 'defaults to true per §3.19').toBe(true)
    expect(parsed.allowMultipleAds, 'defaults to false per §3.19').toBe(false)
    expect(parsed.impressions.length).toBe(1)
    expect(parsed.errors.length).toBe(1)
  })

  it('wrapperAdSequenceIsPreserved', () => {
    const document = parser.parse(fixture('wrapper-multiple-ads'))

    expect(document.entries.map((entry) => entry.sequence)).toEqual([null, 1, 2, null])
    expect(wrapper(document.entries[0]).allowMultipleAds).toBe(true)
  })

  // MARK: - No ad

  it('emptyResponseIsNoAdWithRootError', () => {
    const document = parser.parse(fixture('empty-no-ad'))

    expect(isNoAd(document)).toBe(true)
    expect(document.noAdError).toBe('http://example.com/empty-no-ad')
  })

  // MARK: - Errors

  /**
   * A VAST 1.0 document is well-formed XML under `<VideoAdServingTemplate>`.
   * Reporting it as a parse error would send the ad server the wrong code.
   */
  it('vast1DocumentReportsVersionNotSupported', () => {
    const error = vastErrorFrom(() => parser.parse(fixture('outdated-vast')))
    expect(error).toBe(VastError.VERSION_NOT_SUPPORTED)
    expect(error).toBe(102)
  })

  it('malformedDocumentReportsParseError', () => {
    const error = vastErrorFrom(() => parser.parse(fixture('invalid-xmlfile')))
    expect(error).toBe(VastError.XML_PARSING)
    expect(error).toBe(100)
  })

  // MARK: - The web's own (no Kotlin counterpart)

  /**
   * DOMParser is namespace-aware where SAX is not. A response that uses `xsi:`
   * without declaring it is read by the other SDKs, so it has to be read here.
   */
  it('anUndeclaredPrefixIsReadAsTheOtherSdksReadIt', () => {
    const ad = firstAd(`<?xml version="1.0" encoding="UTF-8"?>
<!-- served by an ad server that forgot xmlns:xsi -->
<VAST version="3.0" xsi:noNamespaceSchemaLocation="vast.xsd">
  <Ad id="undeclared"><InLine>
    <AdSystem>test</AdSystem>
    <Impression><![CDATA[https://ads.test/impression]]></Impression>
    <Creatives><Creative><Linear>
      <Duration>00:00:10</Duration>
      <MediaFiles><MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://ads.test/a.mp4]]></MediaFile></MediaFiles>
    </Linear></Creative></Creatives>
    <Extensions><Extension type="vendor"><v:Key>1</v:Key></Extension></Extensions>
  </InLine></Ad>
</VAST>`)
    expect(ad.id).toBe('undeclared')
    expect(ad.linear.duration).toBe(10)
    expect(ad.extensions.length).toBe(1)
  })

  it('declaringPrefixesRepairsNothingElse', () => {
    const error = vastErrorFrom(() => parser.parse('<VAST version="3.0" xsi:a="1"><Ad id="x"><InLine></Ad></VAST>'))
    expect(error).toBe(VastError.XML_PARSING)
  })

  // MARK: - Offsets

  it('parsesSkipOffsetAsTimestamp', () => {
    const ad = firstAd(linear({ attributes: 'skipoffset="00:00:07.500"' }))

    expect(ad.linear.skipOffset).toEqual({ type: 'time', seconds: 7.5 })
    expect(resolvedSkipOffset(ad.linear)).toBe(7.5)
    expect(isSkippable(ad)).toBe(true)
  })

  it('parsesSkipOffsetAsPercentage', () => {
    const ad = firstAd(linear({ attributes: 'skipoffset="25%"' }))

    expect(ad.linear.skipOffset).toEqual({ type: 'percent', percent: 25.0 })
    const resolved = resolvedSkipOffset(ad.linear)
    expect(resolved).not.toBeNull()
    expect(Math.abs(5.0 - resolved!)).toBeLessThanOrEqual(0.001)
  })

  it('adWithoutSkipOffsetIsNotSkippable', () => {
    const ad = firstAd(linear())
    expect(ad.linear.skipOffset).toBeNull()
    expect(isSkippable(ad)).toBe(false)
  })

  /** `progress` carries an offset and is modelled apart from the quartiles. */
  it('progressEventIsSeparatedFromQuartileEvents', () => {
    const ad = firstAd(
      linear({
        tracking: `
                <Tracking event="start">https://t.test/start</Tracking>
                <Tracking event="progress" offset="00:00:12">https://t.test/p12</Tracking>
                <Tracking event="progress" offset="50%">https://t.test/p50</Tracking>
                `,
      }),
    )

    expect(new Set(Object.keys(ad.linear.trackingEvents))).toEqual(new Set(['start']))
    expect(ad.linear.progressEvents.map((event) => event.offset)).toEqual([
      { type: 'time', seconds: 12.0 },
      { type: 'percent', percent: 50.0 },
    ])
  })

  it('unknownTrackingEventIsIgnoredRatherThanFatal', () => {
    const ad = firstAd(
      linear({
        tracking: `
                <Tracking event="start">https://t.test/start</Tracking>
                <Tracking event="somethingTheSpecNeverDefined">https://t.test/x</Tracking>
                `,
      }),
    )

    expect(new Set(Object.keys(ad.linear.trackingEvents))).toEqual(new Set(['start']))
  })

  // MARK: - Stored URI form

  /**
   * A macro's brackets are stored encoded, as Foundation's `URL(string:)` stores
   * them, so every SDK holds the same string and the expander finds the macro
   * either way.
   */
  it('bracketsInAUriAreStoredEncoded', () => {
    const ad = firstAd(
      linear({ tracking: '<Tracking event="start"><![CDATA[https://t.test/s?e=[ERRORCODE]&x=%3A]]></Tracking>' }),
    )
    // `single()` in the Kotlin: exactly one URI, and it is this one.
    expect(ad.linear.trackingEvents.start, 'an existing escape is left alone').toEqual([
      'https://t.test/s?e=%5BERRORCODE%5D&x=%3A',
    ])
  })

  // MARK: - Synthetic document

  function linear({ attributes = '', tracking = '' }: { attributes?: string; tracking?: string } = {}): string {
    return trimIndent(`
        <?xml version="1.0" encoding="UTF-8"?>
        <VAST version="4.3">
          <Ad id="synthetic">
            <InLine>
              <AdSystem>test</AdSystem>
              <Impression>https://t.test/impression</Impression>
              <Creatives><Creative id="1"><Linear ${attributes}>
                <Duration>00:00:20</Duration>
                <TrackingEvents>${tracking}</TrackingEvents>
                <MediaFiles>
                  <MediaFile delivery="progressive" type="video/mp4">https://t.test/v.mp4</MediaFile>
                </MediaFiles>
              </Linear></Creative></Creatives>
            </InLine>
          </Ad>
        </VAST>
    `)
  }
})

/** Kotlin's `assertFailsWith<VastException> { ... }.error`. */
function vastErrorFrom(block: () => unknown): VastError {
  try {
    block()
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(VastException)
    return (thrown as VastException).error
  }
  throw new Error('expected a VastException, but nothing was thrown')
}

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
