import type { VastAdTag } from '@kinodaran/vast-kit'

/**
 * The Apple and Android demos' scenarios, with the same responses, so the three
 * SDKs can be compared side by side — plus one in Kinodaran's own shape: the
 * same tag requested `max_count` times as one break.
 */
export interface DemoScenario {
  readonly id: string
  readonly title: string
  readonly detail: string
  /** One tag, or several requested back to back as one interruption. */
  readonly tags: readonly (() => VastAdTag)[]
  /** The response asks the player to draw nothing; this page draws its own skip. */
  readonly hostDrawsUI?: boolean
}

/** Content the viewer is "watching": Apple's public HLS sample, so the break visibly pauses and resumes it. */
export const CONTENT_STREAM = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8'

/**
 * Stamps a live tag with a fresh `correlator` before requesting it.
 *
 * Google's ad server dedupes on that parameter: sent empty, the first request
 * is filled and every one after it returns an empty VAST — which the SDK
 * correctly reports as error 303, and which looks exactly like a bug in the
 * SDK. IMA generates this value itself, so a host driving its own player has
 * to do the same. Substituted textually so `cust_params=sample_ct%3Dlinear`
 * goes out exactly as written.
 */
function requestReady(tag: string): string {
  return tag.replace(/correlator=(?=&|$)/, `correlator=${Date.now()}`)
}

const LIVE_LINEAR =
  'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_ad_samples&sz=640x480' +
  '&cust_params=sample_ct%3Dlinear&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator='

const LIVE_SKIPPABLE =
  'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_preroll_skippable&sz=640x480' +
  '&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator='

/** A public W3C sample clip, so the offline scenarios need no ad server and no hosting of our own. 854×480, 52.2s. */
const CREATIVE = 'https://media.w3.org/2010/05/sintel/trailer.mp4'

function inLine(skipOffset: string | null, id = 'demo-1', duration = '00:00:52'): string {
  const skip = skipOffset ? ` skipoffset="${skipOffset}"` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.3">
  <Ad id="${id}">
    <InLine>
      <AdSystem>VASTSDK Demo</AdSystem>
      <AdTitle>${skipOffset ? 'Skippable' : 'Non-skippable'} demo</AdTitle>
      <Error><![CDATA[https://example.com/error?code=[ERRORCODE]]]></Error>
      <Impression><![CDATA[https://example.com/impression]]></Impression>
      <Creatives>
        <Creative id="1">
          <Linear${skip}>
            <Duration>${duration}</Duration>
            <TrackingEvents>
              <Tracking event="start"><![CDATA[https://example.com/start]]></Tracking>
              <Tracking event="firstQuartile"><![CDATA[https://example.com/q1]]></Tracking>
              <Tracking event="midpoint"><![CDATA[https://example.com/q2]]></Tracking>
              <Tracking event="thirdQuartile"><![CDATA[https://example.com/q3]]></Tracking>
              <Tracking event="complete"><![CDATA[https://example.com/complete]]></Tracking>
              <Tracking event="skip"><![CDATA[https://example.com/skip]]></Tracking>
              <Tracking event="progress" offset="00:00:15"><![CDATA[https://example.com/p15]]></Tracking>
            </TrackingEvents>
            <VideoClicks>
              <ClickThrough><![CDATA[https://kinodaran.com]]></ClickThrough>
              <ClickTracking><![CDATA[https://example.com/click]]></ClickTracking>
            </VideoClicks>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" width="854" height="480" bitrate="1200">
                <![CDATA[${CREATIVE}]]>
              </MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
      <Extensions>
        <Extension type="uiSettings"><UiHideable>1</UiHideable></Extension>
      </Extensions>
    </InLine>
  </Ad>
</VAST>`
}

/**
 * Three sequenced ads with deliberately different skip rules, because a pod
 * where they all behave the same proves nothing: the control has to reset per
 * creative rather than carry over. Skip at 2s, then 4s, then not at all.
 */
function pod(): string {
  const offsets = ['00:00:02', '00:00:04', null]
  const ads = offsets.map((offset, i) => {
    const id = `pod-${i + 1}`
    const skip = offset ? ` skipoffset="${offset}"` : ''
    return `  <Ad id="${id}" sequence="${i + 1}">
    <InLine>
      <AdSystem>VASTSDK Demo</AdSystem>
      <AdTitle>${id}</AdTitle>
      <Error><![CDATA[https://example.com/error?code=[ERRORCODE]]]></Error>
      <Impression><![CDATA[https://example.com/impression/${id}]]></Impression>
      <Creatives><Creative><Linear${skip}>
        <Duration>00:00:52</Duration>
        <TrackingEvents>
          <Tracking event="start"><![CDATA[https://example.com/${id}/start]]></Tracking>
          <Tracking event="firstQuartile"><![CDATA[https://example.com/${id}/q1]]></Tracking>
          <Tracking event="midpoint"><![CDATA[https://example.com/${id}/q2]]></Tracking>
          <Tracking event="thirdQuartile"><![CDATA[https://example.com/${id}/q3]]></Tracking>
          <Tracking event="complete"><![CDATA[https://example.com/${id}/complete]]></Tracking>
          <Tracking event="skip"><![CDATA[https://example.com/${id}/skip]]></Tracking>
        </TrackingEvents>
        <MediaFiles>
          <MediaFile delivery="progressive" type="video/mp4" width="854" height="480" bitrate="1200">
            <![CDATA[${CREATIVE}]]>
          </MediaFile>
        </MediaFiles>
      </Linear></Creative></Creatives>
    </InLine>
  </Ad>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<VAST version="4.3">\n${ads.join('\n')}\n</VAST>`
}

const NO_AD = `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.3">
  <Error><![CDATA[https://example.com/no-ad]]></Error>
</VAST>`

const UNSUPPORTED_MEDIA = `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.3">
  <Ad id="bad-media">
    <InLine>
      <AdSystem>VASTSDK Demo</AdSystem>
      <Error><![CDATA[https://example.com/error?code=[ERRORCODE]]]></Error>
      <Impression><![CDATA[https://example.com/impression]]></Impression>
      <Creatives><Creative><Linear>
        <Duration>00:00:15</Duration>
        <MediaFiles>
          <MediaFile delivery="progressive" type="video/x-flv"><![CDATA[https://example.com/creative.flv]]></MediaFile>
        </MediaFiles>
      </Linear></Creative></Creatives>
    </InLine>
  </Ad>
</VAST>`

export const SCENARIOS: readonly DemoScenario[] = [
  {
    id: 'live-linear',
    title: 'Live tag — single inline linear',
    detail: "Google's public IMA sample tag. VAST from a real ad server.",
    tags: [() => requestReady(LIVE_LINEAR)],
  },
  {
    id: 'live-skippable',
    title: 'Live tag — skippable',
    detail: 'Same server, skipoffset 00:00:05 — the skip control is real.',
    tags: [() => requestReady(LIVE_SKIPPABLE)],
  },
  {
    id: 'skippable',
    title: 'Skippable InLine',
    detail: '52s creative, skip unlocks at 5s, 15s progress beacon.',
    tags: [() => ({ xml: inLine('00:00:05') })],
  },
  {
    id: 'non-skippable',
    title: 'Non-skippable InLine',
    detail: '52s creative, no skipoffset — the skip control never appears.',
    tags: [() => ({ xml: inLine(null) })],
  },
  {
    id: 'pod',
    title: 'Ad Pod — 3 ads',
    detail: 'Back to back. Skip at 2s, then 4s, then not at all.',
    tags: [() => ({ xml: pod() })],
  },
  {
    id: 'kinodaran-series',
    title: 'Kinodaran — preroll × 3',
    detail: 'The same tag requested max_count times. Three breaks, one interruption: the film resumes once.',
    tags: [
      () => ({ xml: inLine('00:00:03', 'series-1') }),
      () => ({ xml: inLine('00:00:03', 'series-2') }),
      () => ({ xml: inLine('00:00:03', 'series-3') }),
    ],
  },
  {
    id: 'no-fill',
    title: 'No fill',
    detail: 'Empty response. The session reports VAST error 303 promptly and the film carries on.',
    tags: [() => ({ xml: NO_AD })],
  },
  {
    id: 'host-ui',
    title: 'Custom UI — uiSettings',
    detail: 'Response asks the player to draw nothing. This page draws its own skip, from the snapshot.',
    tags: [() => ({ xml: inLine('00:00:05', 'demo-hostui') })],
    hostDrawsUI: true,
  },
  {
    id: 'bad-media',
    title: 'Unplayable creative',
    detail: 'MediaFile type the browser cannot decode — expect error 403.',
    tags: [() => ({ xml: UNSUPPORTED_MEDIA })],
  },
]
