import {
  createViewableImpression,
  isViewableImpressionEmpty,
  type VastAd,
  type VastExtension,
  type VastViewableImpression,
} from './VastAd.js'
import type { VastBeacon } from './VastBeacon.js'
import { isNoAd, type VastDocument, type VastWrapper } from './VastDocument.js'
import { VastError } from './VastError.js'
import type { VastTrackingEvent, VastTrackingMap } from './VastTrackingEvent.js'
import { normaliseUrl } from './VastUrls.js'
import type { VastVerification } from './VastVerification.js'

/**
 * Fetches a VAST document. Lives in `vast-core` rather than `vast-kit` because
 * wrapper resolution is pure logic that only needs "give me the XML at this
 * URL" — keeping the interface here lets the whole chain be tested with a map
 * of fixtures instead of a network.
 */
export interface VastResourceLoader {
  /**
   * Any failure — a timeout, a dead host, a non-2xx response — is reported by
   * the resolver as 301, so the loader only has to reject, not classify.
   */
  loadVast(url: string, timeoutSeconds: number, signal?: AbortSignal): Promise<string>
}

// `signal` is the web's coroutine cancellation: aborted when the caller stops
// waiting — the resolution budget ran out, or the session was destroyed — so a
// loader can drop the request instead of finishing it for nobody. A loader
// that ignores it is still correct; the resolver checks it either way.

/** What {@link VastWrapperChain.accept} asks of its caller next. */
export type VastWrapperChainStep =
  /** Fetch this tag and call {@link VastWrapperChain.accept} again with the parsed result. */
  | { readonly type: 'follow'; readonly url: string }
  /** The chain ended at an InLine response; these ads carry every tracker collected on the way down. */
  | { readonly type: 'resolved'; readonly ads: readonly VastAd[] }
  | { readonly type: 'failed'; readonly error: VastError }

/**
 * Drives Wrapper redirection without performing any IO.
 *
 * The caller executes a `follow` step with its own loader and feeds the result
 * back in. Depth limits, tracker accumulation, ClickThrough precedence and error
 * reporting are therefore exercised with fixture strings and no network.
 */
export class VastWrapperChain {
  private readonly errors: string[] = []
  private depthReached = 0

  private readonly impressions: string[] = []
  private readonly tracking = new Map<VastTrackingEvent, string[]>()
  private readonly clickTracking: string[] = []

  /**
   * §2.3.5.2: the ClickThrough closest to the InLine response wins, so this is
   * overwritten as the chain descends and by the InLine itself if it has one.
   */
  private clickThrough: string | null = null
  private readonly extensions: VastExtension[] = []
  private readonly verifications: VastVerification[] = []

  /** `<Ad id>` of each Wrapper crossed, in the order they were crossed. */
  private readonly wrapperAdIds: string[] = []

  /** Viewability URIs the Wrappers asked for, kept alongside the InLine's. */
  private viewableImpression: VastViewableImpression | null = null
  private allowMultipleAds = false

  constructor(
    /** §3.19.1: "the player is only required to accept five wrappers". */
    readonly maxDepth: number = 5,
  ) {}

  /**
   * Every `<Error>` seen on the way down. On failure they all fire, because
   * §2.3.5.1 requires each Wrapper in the chain to be told.
   */
  get accumulatedErrors(): readonly string[] {
    return [...this.errors]
  }

  get depth(): number {
    return this.depthReached
  }

  /**
   * Consumes one parsed document.
   *
   * @param baseUrl where this document was fetched from. A `VASTAdTagURI` is
   *   frequently relative, and only the caller knows what to resolve it against.
   */
  accept(document: VastDocument, baseUrl: string | null = null): VastWrapperChainStep {
    if (isNoAd(document)) {
      // §2.3.6.4 names 303 for the no-ad response, and it is the honest code
      // at either depth: no VAST response produced an ad. Reporting a wrapper
      // error for a direct response describes a hop that never happened.
      if (document.noAdError !== null) this.errors.push(document.noAdError)
      return { type: 'failed', error: VastError.NO_VAST_RESPONSE_AFTER_WRAPPERS }
    }

    const inLineAds: VastAd[] = []
    for (const entry of document.entries) {
      if (entry.body.type === 'inLine') inLineAds.push(entry.body.ad)
    }
    if (inLineAds.length > 0) {
      return { type: 'resolved', ads: this.permitted(inLineAds).map((ad) => this.merge(ad)) }
    }

    // No InLine yet, so this is another Wrapper hop.
    const found = firstWrapper(document)
    if (found === null) {
      // Unless the response did contain an ad, just not one with a Linear
      // creative. The server filled the slot; the player wanted a different
      // linearity, and §2.3.6 gives that its own code.
      const unplayable = firstUnplayableCreative(document)
      if (unplayable !== null) {
        this.errors.push(...unplayable)
        return { type: 'failed', error: VastError.UNEXPECTED_LINEARITY }
      }
      return { type: 'failed', error: VastError.WRAPPER_GENERAL }
    }
    const { adId, wrapper } = found
    this.absorb(wrapper, adId)

    if (this.depthReached >= this.maxDepth) {
      return { type: 'failed', error: VastError.WRAPPER_LIMIT_REACHED }
    }
    if (!wrapper.followAdditionalWrappers && this.depthReached !== 0) {
      // The parent forbade further redirection, and this response is not an
      // InLine, so there is nothing left to play.
      return { type: 'failed', error: VastError.NO_VAST_RESPONSE_AFTER_WRAPPERS }
    }
    this.depthReached += 1
    return { type: 'follow', url: VastWrapperChain.resolve(wrapper.tagUri, baseUrl) }
  }

  /**
   * The error beacons owed when the chain fails. Use when the caller's own step
   * fails — a fetch timeout, or a document that will not parse.
   */
  errorBeacons(error: VastError, adId: string = '-'): VastBeacon[] {
    return this.errors.map((url): VastBeacon => ({ kind: { type: 'error', error }, url, adId }))
  }

  /**
   * Applies the calling Wrapper's `allowMultipleAds` constraint (§3.19).
   *
   * The attribute defaults to `false`, which means "only the first stand-alone
   * Ad (with no sequence values) in the requested VAST response is allowed" —
   * so a wrapper that says nothing is asking for one ad, not a pod.
   *
   * A direct response is untouched: the constraint belongs to a wrapper
   * requesting on someone's behalf, and there is no wrapper at depth zero.
   */
  private permitted(ads: readonly VastAd[]): readonly VastAd[] {
    const first = ads[0]
    if (this.depthReached === 0 || this.allowMultipleAds || ads.length <= 1 || first === undefined) return ads

    // Read literally, a pod-only response under this constraint contains
    // nothing that is allowed. Taking its first ad instead keeps the slot
    // filled while still honouring "not multiple" — refusing fill outright
    // would punish the advertiser for the wrapper's default.
    return [ads.find((ad) => ad.sequence === null) ?? first]
  }

  // MARK: - Accumulation

  /**
   * Verifications accumulate like trackers, with one difference that matters: a
   * duplicate tracker is a harmless second request, while a duplicate
   * verification is a second measurement session for a vendor that asked for
   * one. The first mention of a (vendor, resources) pair wins.
   */
  private absorbVerifications(incoming: readonly VastVerification[]): void {
    for (const verification of incoming) {
      if (!this.verifications.some((existing) => isSameVerification(existing, verification))) {
        this.verifications.push(verification)
      }
    }
  }

  private absorbViewableImpression(incoming: VastViewableImpression | null): void {
    if (incoming === null) return
    const existing = this.viewableImpression
    this.viewableImpression = createViewableImpression({
      id: existing?.id ?? incoming.id,
      viewable: [...(existing?.viewable ?? []), ...incoming.viewable],
      notViewable: [...(existing?.notViewable ?? []), ...incoming.notViewable],
      viewUndetermined: [...(existing?.viewUndetermined ?? []), ...incoming.viewUndetermined],
    })
  }

  private absorb(wrapper: VastWrapper, adId: string): void {
    this.impressions.push(...wrapper.impressions)
    this.errors.push(...wrapper.errors)
    this.absorbViewableImpression(wrapper.viewableImpression)
    this.clickTracking.push(...wrapper.clickTracking)
    this.extensions.push(...wrapper.extensions)
    this.absorbVerifications(wrapper.verifications)
    // An ad server that omits `<Ad id>` on a Wrapper leaves nothing to report,
    // and an empty string in the chain would read as a real intermediary.
    if (adId.length > 0) this.wrapperAdIds.push(adId)
    this.allowMultipleAds = wrapper.allowMultipleAds
    for (const [event, urls] of trackingEntries(wrapper.trackingEvents)) {
      const collected = this.tracking.get(event)
      if (collected === undefined) this.tracking.set(event, [...urls])
      else collected.push(...urls)
    }
    if (wrapper.clickThrough !== null) this.clickThrough = wrapper.clickThrough
  }

  /**
   * Folds everything collected on the way down into the resolved ad.
   *
   * A pod resolved through a Wrapper gets the wrapper's trackers on *every*
   * member (§3.3.1), which falls out of merging per ad rather than once.
   */
  private merge(ad: VastAd): VastAd {
    const merged: Partial<Record<VastTrackingEvent, readonly string[]>> = { ...ad.linear.trackingEvents }
    for (const [event, urls] of this.tracking) {
      merged[event] = [...(merged[event] ?? []), ...urls]
    }
    // The spread carries every field the chain does not touch — adServingId,
    // universalAdIds, icons, pricing and the rest — so none of them can be
    // dropped for the responses that came through a Wrapper, which is most.
    return {
      ...ad,
      linear: {
        ...ad.linear,
        // The InLine's own ClickThrough is closest to the creative and
        // therefore wins over anything a calling Wrapper supplied.
        clickThrough: ad.linear.clickThrough ?? this.clickThrough,
        clickTracking: [...ad.linear.clickTracking, ...this.clickTracking],
        trackingEvents: merged,
      },
      impressions: [...ad.impressions, ...this.impressions],
      errors: [...ad.errors, ...this.errors],
      extensions: [...ad.extensions, ...this.extensions],
      adVerifications: this.mergedVerifications(ad),
      wrapperAdIds: [...this.wrapperAdIds],
      viewableImpression: this.mergedViewableImpression(ad),
    }
  }

  /**
   * A Wrapper may ask about viewability too (§3.6), and both are owed an answer:
   * an intermediary that wanted to hear about it does not stop wanting because
   * the InLine wanted to as well.
   */
  private mergedViewableImpression(ad: VastAd): VastViewableImpression | null {
    const chain = this.viewableImpression
    const inLine = ad.viewableImpression
    if (chain === null && inLine === null) return null
    const merged = createViewableImpression({
      id: inLine?.id ?? chain?.id ?? null,
      viewable: [...(inLine?.viewable ?? []), ...(chain?.viewable ?? [])],
      notViewable: [...(inLine?.notViewable ?? []), ...(chain?.notViewable ?? [])],
      viewUndetermined: [...(inLine?.viewUndetermined ?? []), ...(chain?.viewUndetermined ?? [])],
    })
    return isViewableImpressionEmpty(merged) ? null : merged
  }

  /**
   * The InLine's own verifications first — it is closest to the creative — then
   * the chain's, skipping vendors it already asked for.
   */
  private mergedVerifications(ad: VastAd): VastVerification[] {
    const merged = [...ad.adVerifications]
    for (const verification of this.verifications) {
      if (!merged.some((existing) => isSameVerification(existing, verification))) merged.push(verification)
    }
    return merged
  }

  /**
   * Real responses redirect with a relative `VASTAdTagURI`.
   *
   * RFC 3986 §5.2, by hand. The WHATWG `URL` parser would rewrite the base as
   * well as resolve against it — lower-casing the host, dropping a default
   * port, re-encoding per component — and the URL fetched next has to be
   * byte-identical to the one the other SDKs fetch. A base with an empty path
   * still gets the slash before the reference ("http://host" + "a.xml"), as
   * §5.2.3 and Foundation both supply it.
   *
   * The base is stored the way {@link normaliseUrl} stores any URI, as the
   * Apple SDK's `URL` base already is, so a caller's unencoded bracket cannot
   * leave the reference unresolved.
   *
   * @internal
   */
  static resolve(tag: string, base: string | null): string {
    if (SCHEME.test(tag) || base === null) return tag
    const from = parseReference(normaliseUrl(base))
    const reference = parseReference(normaliseUrl(tag))

    let authority: string | null
    let path: string
    let query: string | null
    if (reference.authority !== null) {
      // A network-path reference ("//host/path") keeps its path as written:
      // neither `java.net.URI` nor Foundation removes its dot segments, and
      // agreeing with both matters more here than §5.2.2's letter.
      authority = reference.authority
      path = reference.path
      query = reference.query
    } else {
      authority = from.authority
      if (reference.path === '') {
        path = from.path
        query = reference.query ?? from.query
      } else {
        path = removeDotSegments(reference.path.startsWith('/') ? reference.path : mergePaths(from, reference.path))
        query = reference.query
      }
    }

    let resolved = from.scheme !== null ? `${from.scheme}:` : ''
    if (authority !== null) resolved += `//${authority}`
    resolved += path
    if (query !== null) resolved += `?${query}`
    if (reference.fragment !== null) resolved += `#${reference.fragment}`
    return resolved
  }
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** RFC 3986 Appendix B, with the scheme held to the same grammar as {@link SCHEME}. */
const REFERENCE = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/

/** The five components of §3; `null` is "undefined", which §5.2 keeps distinct from empty. */
interface UriReference {
  readonly scheme: string | null
  readonly authority: string | null
  readonly path: string
  readonly query: string | null
  readonly fragment: string | null
}

/** `value` is already normalised, so it holds no line break for `.` to miss. */
function parseReference(value: string): UriReference {
  const match = REFERENCE.exec(value)
  return {
    scheme: match?.[1] ?? null,
    authority: match?.[2] ?? null,
    path: match?.[3] ?? value,
    query: match?.[4] ?? null,
    fragment: match?.[5] ?? null,
  }
}

/** §5.2.3. */
function mergePaths(base: UriReference, path: string): string {
  if (base.authority !== null && base.path === '') return `/${path}`
  return base.path.substring(0, base.path.lastIndexOf('/') + 1) + path
}

/** §5.2.4, step for step. */
function removeDotSegments(path: string): string {
  let input = path
  let output = ''
  while (input.length > 0) {
    if (input.startsWith('../')) {
      input = input.substring(3)
    } else if (input.startsWith('./')) {
      input = input.substring(2)
    } else if (input.startsWith('/./')) {
      input = input.substring(2)
    } else if (input === '/.') {
      input = '/'
    } else if (input.startsWith('/../') || input === '/..') {
      input = input === '/..' ? '/' : input.substring(3)
      output = output.substring(0, Math.max(output.lastIndexOf('/'), 0))
    } else if (input === '.' || input === '..') {
      input = ''
    } else {
      const end = input.indexOf('/', 1)
      const segment = end < 0 ? input : input.substring(0, end)
      output += segment
      input = input.substring(segment.length)
    }
  }
  return output
}

function firstWrapper(document: VastDocument): { readonly adId: string; readonly wrapper: VastWrapper } | null {
  // A pod's members are handled once the chain resolves; redirection itself
  // follows a single tag, and `allowMultipleAds` governs what the response to
  // it may contain.
  for (const entry of document.entries) {
    if (entry.body.type === 'wrapper') return { adId: entry.id, wrapper: entry.body.wrapper }
  }
  return null
}

/** The `<Error>` URIs of the first ad that was filled but not playable here. */
function firstUnplayableCreative(document: VastDocument): readonly string[] | null {
  for (const entry of document.entries) {
    if (entry.body.type === 'unplayableCreative') return entry.body.errors
  }
  return null
}

function trackingEntries(map: VastTrackingMap): Array<[VastTrackingEvent, readonly string[]]> {
  const entries: Array<[VastTrackingEvent, readonly string[]]> = []
  for (const event of Object.keys(map) as VastTrackingEvent[]) {
    const urls = map[event]
    if (urls !== undefined) entries.push([event, urls])
  }
  return entries
}

function isSameVerification(a: VastVerification, b: VastVerification): boolean {
  if (a.vendor !== b.vendor || a.resources.length !== b.resources.length) return false
  return a.resources.every((resource, index) => resource.url === b.resources[index]?.url)
}
