import type { VastTrackingMap } from './VastTrackingEvent.js'
import type { VastVerification } from './VastVerification.js'

/**
 * A single `<Ad>` resolved down to everything needed to play and track it.
 *
 * A Wrapper chain is already flattened by the time an ad reaches this type:
 * `trackingEvents`, `impressions` and `errors` hold the accumulated URIs from
 * every Wrapper in the chain plus the final InLine, as VAST 4.3 §2.3.5 requires.
 *
 * Plain, readonly data: it can be logged, stored or posted to a worker as it
 * is. What the Apple and Android SDKs expose as computed properties are the
 * functions below it — {@link isSkippable}, {@link isPartOfPod},
 * {@link isUiHidden}.
 *
 * URIs are kept as strings, normalised the way the Apple SDK's `URL(string:)`
 * normalises them: characters that are not legal in a URI — brackets around a
 * macro among them — arrive percent-encoded. `VastMacroExpander` reads both forms.
 */
export interface VastAd {
  readonly id: string
  /** `<Ad sequence="n">`. `null` means a stand-alone ad (VAST 4.3 §3.3.1 "ad buffet"). */
  readonly sequence: number | null
  readonly adSystem: string | null
  readonly title: string | null
  readonly linear: VastLinear
  /** Fired together, the moment the first frame renders (§2.3.4). */
  readonly impressions: readonly string[]
  /** Every `<Error>` in the chain. On failure ALL of them fire (§2.3.5.1). */
  readonly errors: readonly string[]
  /** Vendor-specific `<Extensions>`, handed to the host untouched (§3.18). */
  readonly extensions: readonly VastExtension[]
  /**
   * `<AdVerifications>` (§3.16), accumulated from the whole Wrapper chain and
   * normalised across VAST 3 and 4 shapes. Parsed, never executed — see {@link VastVerification}.
   */
  readonly adVerifications: readonly VastVerification[]
  /**
   * The `id` of every Wrapper crossed to reach this ad, outermost first.
   *
   * Empty for a direct InLine response. Reporting pipelines use this to say
   * which intermediary served an ad, so it is kept rather than discarded with
   * the rest of the Wrapper once the chain is flattened.
   */
  readonly wrapperAdIds: readonly string[]
  /**
   * `<AdServingId>` (§3.4). Required from VAST 4.1.
   *
   * The value both sides quote when their counts disagree: unique to this
   * response, from this server, for this request.
   */
  readonly adServingId: string | null
  /**
   * `<UniversalAdId>` (§3.7.1). Required in VAST 4 — one per `<Creative>`, and
   * the only identifier that means the same thing to both sides.
   */
  readonly universalAdIds: readonly VastUniversalAdId[]
  /** `<ViewableImpression>` (§3.6), if the response asked to hear about viewability. */
  readonly viewableImpression: VastViewableImpression | null
  /**
   * `<Icon>` (§3.15) — AdChoices, in practice. Parsed and handed over; drawing
   * it belongs to whoever owns the ad UI.
   */
  readonly icons: readonly VastIcon[]
  /** `<Advertiser>` (§3.9) — who the ad is for. */
  readonly advertiser: string | null
  /** `<Pricing>` (§3.8) — what the impression cost, as the server states it. */
  readonly pricing: VastPricing | null
  /** `<Category>` (§3.5) — the advertiser's industry. */
  readonly categories: readonly VastCategory[]
  /**
   * `<Expires>` (§3.4) — how long this response may be held before it stops
   * being worth playing, in seconds. Only meaningful to a host that caches
   * responses; this SDK plays them as they arrive.
   */
  readonly expires: number | null
}

/** `<Linear>` — the only creative type this SDK plays. */
export interface VastLinear {
  readonly duration: number
  /**
   * `<Linear skipoffset>`. Non-null means the ad is a Skippable Linear Ad
   * and MUST be offered with skip controls (§2.3).
   */
  readonly skipOffset: VastSkipOffset | null
  readonly mediaFiles: readonly VastMediaFile[]
  readonly clickThrough: string | null
  readonly clickTracking: readonly string[]
  /**
   * `<CustomClick>` (§3.10.3) — trackers for a click the player reports
   * without opening anything, as distinct from `<ClickTracking>`, which
   * accompanies a click-through. Real tags send both.
   */
  readonly customClicks: readonly string[]
  readonly trackingEvents: VastTrackingMap
  /**
   * `<Tracking event="progress" offset="...">` — decides whether a skipped
   * ad still counts as viewed (§3.14.1).
   */
  readonly progressEvents: readonly VastProgressEvent[]
}

/** `HH:MM:SS`, `HH:MM:SS.mmm`, or `n%`. */
export type VastSkipOffset =
  | { readonly type: 'time'; readonly seconds: number }
  | { readonly type: 'percent'; readonly percent: number }

export interface VastProgressEvent {
  readonly offset: VastSkipOffset
  readonly url: string
}

/**
 * One `<Extension>` kept as raw XML. The SDK never interprets these; a host
 * reads its own vendor keys (e.g. Kinodaran's `uiSettings/UiHideable`) with
 * {@link extensionValue}.
 */
export interface VastExtension {
  readonly type: string | null
  readonly xml: string
}

export type VastDelivery = 'progressive' | 'streaming'

export interface VastMediaFile {
  readonly id: string | null
  readonly url: string
  readonly mimeType: string
  readonly delivery: VastDelivery
  readonly width: number | null
  readonly height: number | null
  readonly bitrate: number | null
  readonly minBitrate: number | null
  readonly maxBitrate: number | null
  readonly scalable: boolean
  readonly maintainAspectRatio: boolean
  readonly codec: string | null
}

/**
 * `<UniversalAdId>` (§3.7.1). Required in VAST 4.
 *
 * The one identifier that means the same thing to everyone: an ad server's
 * own `<Ad id>` is its own, while this names the *creative* in a registry
 * both sides can look up.
 */
export interface VastUniversalAdId {
  /** `idRegistry` — who issued the value. `"unknown"` when a server says so. */
  readonly registry: string | null
  readonly value: string
}

/**
 * `<ViewableImpression>` (§3.6).
 *
 * Three outcomes, not one: the ad was viewable, it was not, or the player
 * could not tell. The third is the honest answer for a player with no
 * viewability measurement, and it is the one this SDK sends.
 */
export interface VastViewableImpression {
  readonly id: string | null
  readonly viewable: readonly string[]
  readonly notViewable: readonly string[]
  readonly viewUndetermined: readonly string[]
}

/**
 * `<Icon>` (§3.15) — the AdChoices mark, in practice.
 *
 * Parsed and handed over rather than drawn. What matters is that the
 * response's icon is not silently dropped: §3.15 expects the player to
 * display one, and a response carrying `program="AdChoices"` means somebody
 * upstream undertook to show it.
 */
export interface VastIcon {
  /** `program` — which scheme the icon belongs to, e.g. `AdChoices`. */
  readonly program: string | null
  readonly width: number | null
  readonly height: number | null
  /** `left`, `right`, or a number of pixels. */
  readonly xPosition: string | null
  /** `top`, `bottom`, or a number of pixels. */
  readonly yPosition: string | null
  /** When the icon should appear, from the start of the creative. */
  readonly offset: number | null
  /** How long it should stay. `null` means for the rest of the ad. */
  readonly duration: number | null
  readonly staticResource: string | null
  readonly staticResourceType: string | null
  readonly clickThrough: string | null
  readonly clickTracking: readonly string[]
  readonly viewTracking: readonly string[]
}

/** `<Pricing>` (§3.8). What the impression cost, as the server states it. */
export interface VastPricing {
  /** `CPM`, `CPC`, `CPE`, `CPV`. */
  readonly model: string | null
  /** ISO 4217, e.g. `USD`. */
  readonly currency: string | null
  readonly value: number
}

/** `<Category>` (§3.5) — the advertiser's industry, per some authority. */
export interface VastCategory {
  /** `authority` — the URL of the taxonomy the code belongs to. */
  readonly authority: string | null
  readonly code: string
}

// ---------------------------------------------------------------------------
// What the other SDKs expose as computed properties.

/** Seconds into a creative of `duration` seconds that an offset names. */
export function skipOffsetSeconds(offset: VastSkipOffset, duration: number): number {
  return offset.type === 'time' ? offset.seconds : (duration * offset.percent) / 100
}

/** The linear's `skipoffset` in seconds, or `null` when it is not skippable. */
export function resolvedSkipOffset(linear: VastLinear): number | null {
  return linear.skipOffset ? skipOffsetSeconds(linear.skipOffset, linear.duration) : null
}

/**
 * Whether this is a Skippable Linear Ad: the creative declared a
 * `skipoffset` (§2.3).
 *
 * Not a styling question. An advertiser paid the skippable rate on the
 * strength of that attribute, so this is what decides whether a skip control
 * is owed at all.
 */
export function isSkippable(ad: VastAd): boolean {
  return ad.linear.skipOffset !== null
}

/**
 * Whether the response placed this ad in a pod, by giving it a `sequence`
 * attribute (§3.3.1).
 *
 * A fact about what the ad server trafficked, not about the break being
 * played: a lone `sequence="1"` ad *is* part of a pod while its break has one
 * slot, and a stand-alone ad substituted for a failed pod member is *not*
 * while the break around it still has all of its slots.
 */
export function isPartOfPod(ad: VastAd): boolean {
  return ad.sequence !== null
}

export function isViewableImpressionEmpty(v: VastViewableImpression): boolean {
  return v.viewable.length === 0 && v.notViewable.length === 0 && v.viewUndetermined.length === 0
}

/**
 * The text of a direct child element of an extension, e.g.
 * `extensionValue(ext, 'UiHideable')` on a `uiSettings` extension.
 *
 * Reading a vendor key should not mean writing a string scanner in every
 * host. This still assigns the value no meaning — whether `"1"` means the
 * UI should hide is the vendor's convention, and the host's to apply.
 *
 * `null` when the element is absent; an element present but empty yields
 * `""`, which is a different fact and is reported as such.
 */
export function extensionValue(extension: VastExtension, element: string): string | null {
  const xml = extension.xml
  const openStart = xml.indexOf(`<${element}`)
  if (openStart < 0) return null
  const nameEnd = openStart + element.length + 1
  const openEnd = xml.indexOf('>', nameEnd)
  if (openEnd < 0) return null

  // `<UiHideable/>` carries no text, and its ">" belongs to the open tag.
  if (xml.substring(nameEnd, openEnd).endsWith('/')) return ''

  const bodyStart = openEnd + 1
  const closeStart = xml.indexOf(`</${element}>`, bodyStart)
  if (closeStart < 0) return null

  return extensionText(xml.substring(bodyStart, closeStart))
}

/** Ad servers wrap extension values in CDATA about as often as not. */
function extensionText(body: string): string {
  let text = body.trim()
  if (text.startsWith('<![CDATA[') && text.endsWith(']]>')) {
    text = text.substring('<![CDATA['.length, text.length - ']]>'.length)
  }
  return text.trim()
}

// ---------------------------------------------------------------------------
// Construction with the defaults the other SDKs give their data classes.

export type VastAdInit = Partial<VastAd> & Pick<VastAd, 'id' | 'linear'>
export type VastLinearInit = Partial<VastLinear> & Pick<VastLinear, 'duration'>
export type VastMediaFileInit = Partial<VastMediaFile> & Pick<VastMediaFile, 'url' | 'mimeType'>
export type VastIconInit = Partial<VastIcon>
export type VastViewableImpressionInit = Partial<VastViewableImpression>

export function createAd(init: VastAdInit): VastAd {
  return {
    id: init.id,
    sequence: init.sequence ?? null,
    adSystem: init.adSystem ?? null,
    title: init.title ?? null,
    linear: init.linear,
    impressions: init.impressions ?? [],
    errors: init.errors ?? [],
    extensions: init.extensions ?? [],
    adVerifications: init.adVerifications ?? [],
    wrapperAdIds: init.wrapperAdIds ?? [],
    adServingId: init.adServingId ?? null,
    universalAdIds: init.universalAdIds ?? [],
    viewableImpression: init.viewableImpression ?? null,
    icons: init.icons ?? [],
    advertiser: init.advertiser ?? null,
    pricing: init.pricing ?? null,
    categories: init.categories ?? [],
    expires: init.expires ?? null,
  }
}

export function createLinear(init: VastLinearInit): VastLinear {
  return {
    duration: init.duration,
    skipOffset: init.skipOffset ?? null,
    mediaFiles: init.mediaFiles ?? [],
    clickThrough: init.clickThrough ?? null,
    clickTracking: init.clickTracking ?? [],
    customClicks: init.customClicks ?? [],
    trackingEvents: init.trackingEvents ?? {},
    progressEvents: init.progressEvents ?? [],
  }
}

export function createMediaFile(init: VastMediaFileInit): VastMediaFile {
  return {
    id: init.id ?? null,
    url: init.url,
    mimeType: init.mimeType,
    delivery: init.delivery ?? 'progressive',
    width: init.width ?? null,
    height: init.height ?? null,
    bitrate: init.bitrate ?? null,
    minBitrate: init.minBitrate ?? null,
    maxBitrate: init.maxBitrate ?? null,
    scalable: init.scalable ?? true,
    maintainAspectRatio: init.maintainAspectRatio ?? true,
    codec: init.codec ?? null,
  }
}

export function createIcon(init: VastIconInit = {}): VastIcon {
  return {
    program: init.program ?? null,
    width: init.width ?? null,
    height: init.height ?? null,
    xPosition: init.xPosition ?? null,
    yPosition: init.yPosition ?? null,
    offset: init.offset ?? null,
    duration: init.duration ?? null,
    staticResource: init.staticResource ?? null,
    staticResourceType: init.staticResourceType ?? null,
    clickThrough: init.clickThrough ?? null,
    clickTracking: init.clickTracking ?? [],
    viewTracking: init.viewTracking ?? [],
  }
}

export function createViewableImpression(init: VastViewableImpressionInit = {}): VastViewableImpression {
  return {
    id: init.id ?? null,
    viewable: init.viewable ?? [],
    notViewable: init.notViewable ?? [],
    viewUndetermined: init.viewUndetermined ?? [],
  }
}
