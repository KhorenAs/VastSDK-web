import {
  createAd,
  createIcon,
  createLinear,
  createMediaFile,
  createViewableImpression,
  isViewableImpressionEmpty,
  type VastAd,
  type VastCategory,
  type VastDelivery,
  type VastExtension,
  type VastIcon,
  type VastMediaFile,
  type VastPricing,
  type VastProgressEvent,
  type VastSkipOffset,
  type VastUniversalAdId,
  type VastViewableImpression,
} from './VastAd.js'
import { createWrapper, type VastDocument, type VastDocumentEntry } from './VastDocument.js'
import { VastError, VastException } from './VastError.js'
import { VastTrackingEvent, type VastTrackingMap } from './VastTrackingEvent.js'
import { urlFrom } from './VastUrls.js'
import {
  createVerification,
  createVerificationResource,
  type VastVerification,
  type VastVerificationResource,
  type VastVerificationResourceKind,
} from './VastVerification.js'

/**
 * Turns VAST XML into a {@link VastDocument}.
 *
 * Deliberately version-tolerant. Real ad servers still emit VAST 2.0 and 3.0,
 * 4.x adds elements this SDK does not play, and almost every server has its own
 * idea of how to write a URI — bare text, CDATA, or CDATA padded with newlines.
 * Unknown elements are skipped rather than rejected; only XML that will not
 * parse at all raises {@link VastError.XML_PARSING} (100).
 *
 * Built on the platform `DOMParser` because it is in every browser this SDK
 * runs in and costs no dependency, and it is the only browser API `vast-core`
 * touches. The parsed tree is then walked as the same event stream SAX and
 * Foundation's `XMLParser` deliver — element start, text, CDATA, element end —
 * which keeps the builder below a line-for-line port of the Apple and Android
 * builders rather than a reinterpretation of them.
 */
export class VastParser {
  /** @throws VastException with {@link VastError.XML_PARSING} (100) when the XML is malformed. */
  parse(xml: string): VastDocument {
    const builder = new Builder()
    let dom = parseXml(xml)
    if (dom.documentElement === null || isMalformed(dom)) {
      // The one way DOMParser is stricter than the SAX and `XMLParser`
      // builders: a prefix used without being declared. Declaring what is
      // missing and trying once more reads such a response the way the other
      // SDKs do, and changes nothing for XML that is broken in any other way.
      const repaired = declaringUndeclaredPrefixes(xml)
      if (repaired !== null) dom = parseXml(repaired)
    }
    const root: Element | null = dom.documentElement
    if (root === null || isMalformed(dom)) throw new VastException(VastError.XML_PARSING)
    walk(root, builder)
    // A VAST 1.0 document is well-formed XML under a different root element.
    // Reporting it as a parse error would tell the ad server the wrong thing,
    // so it gets the code the spec reserves for it.
    if (builder.sawUnsupportedRoot) throw new VastException(VastError.VERSION_NOT_SUPPORTED)
    const document = builder.document
    if (document === null) throw new VastException(VastError.XML_PARSING)
    return document
  }
}

// MARK: - DOM

function parseXml(xml: string): Document {
  try {
    // An ad response has no business reaching outside itself. A browser's
    // DOMParser never loads an external DTD or entity, so unlike the JVM
    // parser there is nothing here to switch off.
    return new DOMParser().parseFromString(xml, 'text/xml')
  } catch (cause) {
    throw new VastException(VastError.XML_PARSING, { cause })
  }
}

/**
 * The response with every namespace prefix it uses but never declares
 * declared on its root element, or `null` when there is none to declare.
 *
 * Real ad servers send `xsi:noNamespaceSchemaLocation` without `xmlns:xsi`
 * often enough to matter. The namespace each prefix is bound to is a
 * placeholder, which costs nothing: the builder matches names as written,
 * prefix included, exactly as the Apple and Android builders do.
 */
function declaringUndeclaredPrefixes(xml: string): string | null {
  const used = new Set<string>()
  // `exec` loops rather than `matchAll`, which is ES2020 — newer than the
  // Chromium in the smart TVs this SDK has to run on.
  const each = (pattern: RegExp, visit: (prefix: string) => void): void => {
    for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) visit(match[1]!)
  }
  each(/<\/?([A-Za-z_][\w.-]*):[A-Za-z_]/g, (prefix) => used.add(prefix))
  each(/\s([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*\s*=/g, (prefix) => used.add(prefix))
  each(/xmlns:([A-Za-z_][\w.-]*)\s*=/g, (prefix) => used.delete(prefix))
  used.delete('xml')
  used.delete('xmlns')
  if (used.size === 0) return null

  // The root's start tag: the first `<` that opens an element, past the XML
  // declaration, comments and a doctype.
  const root = /<([A-Za-z_][\w.:-]*)/g
  for (let match = root.exec(xml); match; match = root.exec(xml)) {
    const before = xml.lastIndexOf('<!--', match.index)
    if (before >= 0 && xml.indexOf('-->', before) > match.index) continue
    const at = match.index + match[0].length
    const declarations = [...used].map((prefix) => ` xmlns:${prefix}="urn:vastsdk:undeclared:${prefix}"`).join('')
    return xml.slice(0, at) + declarations + xml.slice(at)
  }
  return null
}

/**
 * Where this engine files the `<parsererror>` it reports malformed XML with:
 * the XHTML namespace in Chrome and Safari, Mozilla's own in Firefox and jsdom.
 * Learned once from a document that cannot parse, so that a response which
 * merely *contains* a `<parsererror>` element — in a vendor extension, say — is
 * not mistaken for a broken one. `null` when the engine uses no namespace, and
 * then any `<parsererror>` counts.
 */
let parserErrorNamespace: string | null | undefined

/**
 * DOMParser does not throw on malformed XML; it returns a document reporting
 * the error. Chrome and Safari insert a `<parsererror>` somewhere in whatever
 * they managed to parse, Firefox makes it the root — so it is searched for
 * rather than expected in one place.
 *
 * DOMParser is always namespace-aware, where the SAX and `XMLParser` builders
 * are not: an undeclared prefix (`xsi:` with no `xmlns:xsi`) is malformed to
 * it. `parse` repairs that one case and asks again; see
 * {@link declaringUndeclaredPrefixes}.
 */
function isMalformed(dom: Document): boolean {
  if (parserErrorNamespace === undefined) {
    const probe = new DOMParser().parseFromString('<', 'text/xml')
    parserErrorNamespace = probe.getElementsByTagNameNS('*', 'parsererror').item(0)?.namespaceURI ?? null
  }
  const found =
    parserErrorNamespace === null
      ? dom.getElementsByTagNameNS('*', 'parsererror')
      : dom.getElementsByTagNameNS(parserErrorNamespace, 'parsererror')
  return found.length > 0
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4

/**
 * Replays the tree as SAX events, in document order. Comments and processing
 * instructions are skipped, as the SAX builder's no-op handlers skip them.
 *
 * Iterative rather than recursive: nesting depth is the response's to choose,
 * and a deep enough document must not overflow the stack.
 */
function walk(root: Element, builder: Builder): void {
  let node: Node = root
  for (;;) {
    if (node.nodeType === ELEMENT_NODE) {
      const element = node as Element
      builder.startElement(element.tagName, attributeMap(element))
      const child = element.firstChild
      if (child !== null) {
        node = child
        continue
      }
      builder.endElement(element.tagName)
    } else if (node.nodeType === TEXT_NODE) {
      builder.characters(node.nodeValue ?? '')
    } else if (node.nodeType === CDATA_SECTION_NODE) {
      builder.startCDATA()
      builder.characters(node.nodeValue ?? '')
      builder.endCDATA()
    }

    // Climb until there is a sibling to visit, closing each parent on the way.
    for (;;) {
      if (node === root) return
      const sibling: Node | null = node.nextSibling
      if (sibling !== null) {
        node = sibling
        break
      }
      const parent = node.parentNode as Element | null
      if (parent === null) return
      node = parent
      builder.endElement(parent.tagName)
    }
  }
}

// MARK: - Builder

class Builder {
  document: VastDocument | null = null

  /** Set when the root element is not `<VAST>` — i.e. a pre-3.0 document. */
  sawUnsupportedRoot = false

  private version = ''
  private readonly entries: VastDocumentEntry[] = []
  private rootError: string | null = null

  private readonly path: string[] = []
  private text = ''

  // CDATA arrives through `characters` between these two calls.
  private insideCdata = false
  private cdata = ''

  // Current <Ad>
  private adId = ''
  private adSequence: number | null = null
  private isWrapper = false

  private readonly impressions: string[] = []
  private readonly errors: string[] = []
  private tagUri: string | null = null
  private adSystem: string | null = null
  private adTitle: string | null = null
  private followAdditionalWrappers = true
  private allowMultipleAds = false
  private fallbackOnNoAd: boolean | null = null

  // VAST 4 metadata. Required elements, in the parts of the spec that decide
  // whose count is right when two reports disagree.
  private adServingId: string | null = null
  private readonly universalAdIds: VastUniversalAdId[] = []
  private pendingUniversalAdIdRegistry: string | null = null
  private advertiser: string | null = null
  private pricing: VastPricing | null = null
  private pendingPricing: Attributes = EMPTY
  private readonly categories: VastCategory[] = []
  private pendingCategoryAuthority: string | null = null
  private expires: number | null = null

  // Current <ViewableImpression>
  private sawViewableImpression = false
  private viewableImpressionId: string | null = null
  private readonly viewable: string[] = []
  private readonly notViewable: string[] = []
  private readonly viewUndetermined: string[] = []

  // Current <Icon>
  private readonly icons: VastIcon[] = []
  private insideIcon = false
  private pendingIcon: Attributes = EMPTY
  private iconStaticResource: string | null = null
  private iconStaticType: string | null = null
  private iconClickThrough: string | null = null
  private readonly iconClickTracking: string[] = []
  private readonly iconViewTracking: string[] = []

  // Current <Linear>
  private duration = 0
  private skipOffset: VastSkipOffset | null = null
  private readonly mediaFiles: VastMediaFile[] = []
  private clickThrough: string | null = null
  private readonly clickTracking: string[] = []
  private readonly customClicks: string[] = []
  private tracking: Partial<Record<VastTrackingEvent, string[]>> = {}
  private readonly progress: VastProgressEvent[] = []

  private pendingTrackingEvent: string | null = null
  private pendingTrackingOffset: string | null = null
  private pendingMediaFile: Attributes = EMPTY

  /**
   * Set by `<NonLinearAds>` or `<CompanionAds>`: creatives this SDK ignores, but
   * whose presence distinguishes "not playable here" from "no fill".
   */
  private sawUnplayableCreative = false

  // Current <AdVerifications>
  //
  // VAST 4 puts these under <InLine>/<Wrapper>; VAST 3 had no element for them
  // and vendors shipped the same content inside <Extension type="AdVerifications">.
  // Both shapes land in the same list — a host should not have to know which
  // version the server speaks.
  private readonly verifications: VastVerification[] = []

  /** Inside `<AdVerifications>` — or the VAST 3 extension standing in for it. */
  private insideVerifications = false

  /**
   * True while the extension currently open is that VAST 3 stand-in, so its
   * `</Extension>` closes the verification scope rather than a raw capture.
   */
  private extensionIsVerifications = false
  private verificationVendor: string | null = null
  private readonly verificationResources: VastVerificationResource[] = []
  private verificationParameters: string | null = null
  private readonly verificationNotExecuted: string[] = []
  private pendingResource: Attributes = EMPTY

  // Raw <Extension> capture
  private readonly extensions: VastExtension[] = []
  private extensionDepth = 0
  private extensionType: string | null = null
  private extensionXml = ''

  // MARK: Content

  // One branch per VAST element: split up, the element table would be scattered.
  startElement(element: string, attributes: Attributes): void {
    // Everything under <Extension> is copied verbatim: the SDK never
    // interprets vendor XML, it just hands it to the host (§3.18).
    if (this.extensionDepth > 0) {
      this.extensionXml += '<' + element + attributeString(attributes) + '>'
      this.extensionDepth += 1
      this.path.push(element)
      return
    }

    if (this.path.length === 0 && element !== 'VAST') {
      this.sawUnsupportedRoot = true
    }

    this.path.push(element)
    this.text = ''

    switch (element) {
      case 'VAST':
        this.version = attributes.get('version') ?? ''
        break

      case 'Ad': {
        this.resetAd()
        this.adId = attributes.get('id') ?? ''
        const sequence = attributes.get('sequence')
        this.adSequence = sequence === undefined ? null : integer(sequence)
        break
      }

      case 'Wrapper': {
        this.isWrapper = true
        this.followAdditionalWrappers = bool(attributes.get('followAdditionalWrappers'), true)
        this.allowMultipleAds = bool(attributes.get('allowMultipleAds'), false)
        const fallbackOnNoAd = attributes.get('fallbackOnNoAd')
        this.fallbackOnNoAd = fallbackOnNoAd === undefined ? null : bool(fallbackOnNoAd, false)
        break
      }

      case 'Linear': {
        const skipOffset = attributes.get('skipoffset')
        this.skipOffset = skipOffset === undefined ? null : offset(skipOffset)
        break
      }

      case 'Tracking':
        this.pendingTrackingEvent = attributes.get('event') ?? null
        this.pendingTrackingOffset = attributes.get('offset') ?? null
        break

      case 'MediaFile':
        this.pendingMediaFile = attributes
        break

      case 'UniversalAdId':
        this.pendingUniversalAdIdRegistry = attributes.get('idRegistry') ?? null
        break

      case 'ViewableImpression':
        this.sawViewableImpression = true
        this.viewableImpressionId = attributes.get('id') ?? null
        break

      case 'Icon':
        this.insideIcon = true
        this.pendingIcon = attributes
        this.iconStaticResource = null
        this.iconStaticType = null
        this.iconClickThrough = null
        this.iconClickTracking.length = 0
        this.iconViewTracking.length = 0
        break

      // Also a NonLinear and Companion element, neither of which this SDK
      // plays; only an icon's copy is kept.
      case 'StaticResource':
        if (this.insideIcon) this.iconStaticType = attributes.get('creativeType') ?? null
        break

      case 'Pricing':
        this.pendingPricing = attributes
        break

      case 'Category':
        this.pendingCategoryAuthority = attributes.get('authority') ?? null
        break

      case 'AdVerifications':
        this.insideVerifications = true
        break

      case 'Verification':
        this.verificationVendor = attributes.get('vendor') ?? null
        this.verificationResources.length = 0
        this.verificationParameters = null
        this.verificationNotExecuted.length = 0
        // A Verification outside <AdVerifications> is the VAST 3 shape with
        // the wrapper element omitted; treat the scope as open either way.
        this.insideVerifications = true
        break

      case 'JavaScriptResource':
      case 'ExecutableResource':
        this.pendingResource = attributes
        break

      case 'Extension':
        // The VAST 3 stand-in is parsed, not captured raw: a host asking for
        // `adVerifications` should get them whatever the server speaks, and
        // returning the same content twice would invite double-reporting.
        if (attributes.get('type')?.toLowerCase() === 'adverifications') {
          this.extensionIsVerifications = true
          this.insideVerifications = true
          return
        }
        this.extensionDepth = 1
        this.extensionType = attributes.get('type') ?? null
        this.extensionXml = ''
        break

      // Not parsed — but seeing one changes what an ad with no Linear means:
      // the server filled the slot, just not with something playable here.
      case 'NonLinearAds':
      case 'CompanionAds':
        this.sawUnplayableCreative = true
        break
    }
  }

  characters(chars: string): void {
    if (this.insideCdata) {
      this.cdata += chars
      return
    }
    if (this.extensionDepth > 0) {
      this.extensionXml += chars
    } else {
      this.text += chars
    }
  }

  startCDATA(): void {
    this.insideCdata = true
    this.cdata = ''
  }

  /**
   * Ad servers wrap URIs inconsistently, so CDATA feeds the same buffer as plain
   * text and is trimmed later — except inside a raw-captured extension, which
   * keeps its CDATA so the host sees what the server sent.
   */
  endCDATA(): void {
    this.insideCdata = false
    if (this.extensionDepth > 0) {
      this.extensionXml += '<![CDATA[' + this.cdata + ']]>'
    } else {
      this.text += this.cdata
    }
    this.cdata = ''
  }

  endElement(element: string): void {
    try {
      this.closeElement(element)
    } finally {
      if (this.path.length > 0) this.path.pop()
    }
  }

  // One branch per VAST element, as in startElement.
  private closeElement(element: string): void {
    if (this.extensionDepth > 0) {
      this.extensionDepth -= 1
      if (this.extensionDepth === 0) {
        this.extensions.push({ type: this.extensionType, xml: this.extensionXml })
        this.extensionType = null
        this.extensionXml = ''
      } else {
        this.extensionXml += '</' + element + '>'
      }
      return
    }

    const value = this.text.trim()
    this.text = ''

    switch (element) {
      case 'AdSystem':
        this.adSystem = value
        break

      case 'AdServingId':
        this.adServingId = value.length > 0 ? value : null
        break

      case 'UniversalAdId':
        // A registry of "unknown" is a real answer some servers give; only an
        // empty value means there is nothing to record.
        if (value.length > 0) this.universalAdIds.push({ registry: this.pendingUniversalAdIdRegistry, value })
        this.pendingUniversalAdIdRegistry = null
        break

      case 'Advertiser':
        this.advertiser = value.length > 0 ? value : null
        break

      case 'Pricing': {
        const attributes = this.pendingPricing
        this.pendingPricing = EMPTY
        const amount = decimal(value)
        if (amount !== null) {
          this.pricing = {
            model: attributes.get('model') ?? null,
            currency: attributes.get('currency') ?? null,
            value: amount,
          }
        }
        break
      }

      case 'Category': {
        const authority = this.pendingCategoryAuthority
        this.pendingCategoryAuthority = null
        if (value.length > 0) this.categories.push({ authority, code: value })
        break
      }

      // Plain seconds, unlike <Duration>'s timecode.
      case 'Expires':
        this.expires = decimal(value)
        break

      case 'Viewable':
        append(value, this.viewable)
        break
      case 'NotViewable':
        append(value, this.notViewable)
        break
      case 'ViewUndetermined':
        append(value, this.viewUndetermined)
        break

      case 'StaticResource':
        if (this.insideIcon) this.iconStaticResource = urlFrom(value)
        break
      case 'IconClickThrough':
        this.iconClickThrough = urlFrom(value)
        break
      case 'IconClickTracking':
        append(value, this.iconClickTracking)
        break
      case 'IconViewTracking':
        append(value, this.iconViewTracking)
        break
      case 'Icon':
        this.finishIcon()
        break

      case 'CustomClick':
        append(value, this.customClicks)
        break

      case 'AdTitle':
        this.adTitle = value
        break

      case 'Impression':
        append(value, this.impressions)
        break

      case 'Error':
        // A root-level <Error> with no <Ad> is the "no ad" response (§2.3.6.4).
        if (this.path.length <= 2) this.rootError = urlFrom(value)
        else append(value, this.errors)
        break

      // May be relative (real responses do this). Resolution against the
      // document's own base URL belongs to the loader, which is the only layer
      // that knows where this XML was fetched from.
      case 'VASTAdTagURI':
        this.tagUri = urlFrom(value)
        break

      case 'Duration':
        this.duration = seconds(value) ?? 0
        break

      case 'ClickThrough':
        this.clickThrough = urlFrom(value)
        break

      case 'ClickTracking':
        append(value, this.clickTracking)
        break

      case 'MediaFile':
        this.appendMediaFile(value)
        break

      // `<TrackingEvents>` appears under both `<Linear>` and `<Verification>`.
      // Without the scope, a verification's tracker would be filed as a
      // creative event — and since `verificationNotExecuted` is not one, it
      // would vanish instead.
      case 'Tracking':
        if (this.insideVerifications) this.appendVerificationTracking(value)
        else this.appendTracking(value)
        break

      case 'JavaScriptResource':
        this.appendVerificationResource('javaScript', value)
        break
      case 'ExecutableResource':
        this.appendVerificationResource('executable', value)
        break

      case 'VerificationParameters':
        this.verificationParameters = value.length > 0 ? value : null
        break

      case 'Verification':
        this.finishVerification()
        break

      case 'AdVerifications':
        this.insideVerifications = false
        break

      // Only reached for the VAST 3 stand-in; a raw-captured extension is
      // closed by the depth branch above and never falls through to here.
      case 'Extension':
        if (this.extensionIsVerifications) {
          this.extensionIsVerifications = false
          this.insideVerifications = false
        }
        break

      case 'Ad':
        this.finishAd()
        break

      case 'VAST':
        this.document = { version: this.version, entries: this.entries.slice(), noAdError: this.rootError }
        break
    }
  }

  // MARK: - Assembly

  private appendTracking(value: string): void {
    const name = this.pendingTrackingEvent
    const url = urlFrom(value)
    if (name === null || url === null) return
    const offsetValue = this.pendingTrackingOffset
    this.pendingTrackingEvent = null
    this.pendingTrackingOffset = null

    // `progress` carries an offset and drives skippable-ad billing, so it is
    // modelled separately from the fixed quartiles (§3.14.1).
    if (name === 'progress') {
      const at = offsetValue === null ? null : offset(offsetValue)
      if (at === null) return
      this.progress.push({ offset: at, url })
      return
    }
    const event = VastTrackingEvent.fromVastName(name)
    if (event === null) return
    const urls = this.tracking[event]
    if (urls) urls.push(url)
    else this.tracking[event] = [url]
  }

  private appendMediaFile(value: string): void {
    const attributes = this.pendingMediaFile
    this.pendingMediaFile = EMPTY
    const url = urlFrom(value)
    if (url === null) return
    this.mediaFiles.push(
      createMediaFile({
        id: attributes.get('id') ?? null,
        url,
        mimeType: attributes.get('type') ?? '',
        delivery: delivery(attributes.get('delivery') ?? '') ?? 'progressive',
        width: optionalInteger(attributes.get('width')),
        height: optionalInteger(attributes.get('height')),
        bitrate: optionalInteger(attributes.get('bitrate')),
        minBitrate: optionalInteger(attributes.get('minBitrate')),
        maxBitrate: optionalInteger(attributes.get('maxBitrate')),
        scalable: bool(attributes.get('scalable'), true),
        maintainAspectRatio: bool(attributes.get('maintainAspectRatio'), true),
        codec: attributes.get('codec') ?? null,
      }),
    )
  }

  private appendVerificationResource(kind: VastVerificationResourceKind, value: string): void {
    const attributes = this.pendingResource
    this.pendingResource = EMPTY
    if (!this.insideVerifications) return
    const url = urlFrom(value)
    if (url === null) return
    this.verificationResources.push(
      createVerificationResource({
        kind,
        url,
        apiFramework: attributes.get('apiFramework') ?? null,
        browserOptional: bool(attributes.get('browserOptional'), false),
        type: attributes.get('type') ?? null,
      }),
    )
  }

  /** The only tracker a `<Verification>` may carry (§3.16). */
  private appendVerificationTracking(value: string): void {
    const event = this.pendingTrackingEvent
    this.pendingTrackingEvent = null
    this.pendingTrackingOffset = null
    if (event !== 'verificationNotExecuted') return
    const url = urlFrom(value)
    if (url === null) return
    this.verificationNotExecuted.push(url)
  }

  /**
   * A `<Verification>` with no resource at all asks for nothing and is dropped;
   * one with only an unusable resource is kept, because the vendor still expects
   * to hear why it did not run.
   */
  private finishVerification(): void {
    if (this.verificationResources.length > 0) {
      this.verifications.push(
        createVerification({
          vendor: this.verificationVendor,
          resources: this.verificationResources.slice(),
          parameters: this.verificationParameters,
          notExecutedTrackers: this.verificationNotExecuted.slice(),
        }),
      )
    }
    this.verificationVendor = null
    this.verificationResources.length = 0
    this.verificationParameters = null
    this.verificationNotExecuted.length = 0
  }

  /** A `<ViewableImpression>` with no URI at all asked for nothing. */
  private finishedViewableImpression(): VastViewableImpression | null {
    if (!this.sawViewableImpression) return null
    const impression = createViewableImpression({
      id: this.viewableImpressionId,
      viewable: this.viewable.slice(),
      notViewable: this.notViewable.slice(),
      viewUndetermined: this.viewUndetermined.slice(),
    })
    return isViewableImpressionEmpty(impression) ? null : impression
  }

  /**
   * An icon with nothing to draw is dropped: a host cannot render an absent
   * image, and keeping it would look like an AdChoices mark that failed.
   */
  private finishIcon(): void {
    const attributes = this.pendingIcon
    const resource = this.iconStaticResource
    if (resource !== null) {
      this.icons.push(
        createIcon({
          program: attributes.get('program') ?? null,
          // Real tags send width="" — an empty attribute is not a zero.
          width: optionalInteger(attributes.get('width')),
          height: optionalInteger(attributes.get('height')),
          xPosition: attributes.get('xPosition') ?? null,
          yPosition: attributes.get('yPosition') ?? null,
          offset: optionalSeconds(attributes.get('offset')),
          duration: optionalSeconds(attributes.get('duration')),
          staticResource: resource,
          staticResourceType: this.iconStaticType,
          clickThrough: this.iconClickThrough,
          clickTracking: this.iconClickTracking.slice(),
          viewTracking: this.iconViewTracking.slice(),
        }),
      )
    }
    this.insideIcon = false
    this.pendingIcon = EMPTY
    this.iconStaticResource = null
    this.iconStaticType = null
    this.iconClickThrough = null
    this.iconClickTracking.length = 0
    this.iconViewTracking.length = 0
  }

  // Every field of an ad, assembled in one place.
  private finishAd(): void {
    let entry: VastDocumentEntry

    if (this.isWrapper) {
      const tagUri = this.tagUri
      if (tagUri === null) return this.resetAd()
      entry = {
        id: this.adId,
        sequence: this.adSequence,
        body: {
          type: 'wrapper',
          wrapper: createWrapper({
            tagUri,
            impressions: this.impressions.slice(),
            errors: this.errors.slice(),
            trackingEvents: this.frozenTracking(),
            clickTracking: this.clickTracking.slice(),
            clickThrough: this.clickThrough,
            extensions: this.extensions.slice(),
            verifications: this.verifications.slice(),
            viewableImpression: this.finishedViewableImpression(),
            followAdditionalWrappers: this.followAdditionalWrappers,
            allowMultipleAds: this.allowMultipleAds,
            fallbackOnNoAd: this.fallbackOnNoAd,
          }),
        },
      }
    } else {
      // An InLine with no playable Linear is not an ad. If it offered a
      // NonLinear or Companion creative the slot was filled — the response is
      // simply the wrong linearity, and §2.3.6 reserves 201 for that. Dropping
      // it silently would report "no fill" and throw away the `<Error>` URI
      // the server expected to hear on.
      if (this.mediaFiles.length === 0 && this.duration <= 0) {
        if (this.sawUnplayableCreative) {
          this.entries.push({
            id: this.adId,
            sequence: this.adSequence,
            body: { type: 'unplayableCreative', errors: this.errors.slice() },
          })
        }
        return this.resetAd()
      }
      const ad: VastAd = createAd({
        id: this.adId,
        sequence: this.adSequence,
        adSystem: this.adSystem,
        title: this.adTitle,
        linear: createLinear({
          duration: this.duration,
          skipOffset: this.skipOffset,
          mediaFiles: this.mediaFiles.slice(),
          clickThrough: this.clickThrough,
          clickTracking: this.clickTracking.slice(),
          customClicks: this.customClicks.slice(),
          trackingEvents: this.frozenTracking(),
          progressEvents: this.progress.slice(),
        }),
        impressions: this.impressions.slice(),
        errors: this.errors.slice(),
        extensions: this.extensions.slice(),
        adVerifications: this.verifications.slice(),
        adServingId: this.adServingId,
        universalAdIds: this.universalAdIds.slice(),
        viewableImpression: this.finishedViewableImpression(),
        icons: this.icons.slice(),
        advertiser: this.advertiser,
        pricing: this.pricing,
        categories: this.categories.slice(),
        expires: this.expires,
      })
      entry = { id: this.adId, sequence: this.adSequence, body: { type: 'inLine', ad } }
    }

    this.entries.push(entry)
    this.resetAd()
  }

  private frozenTracking(): VastTrackingMap {
    const frozen: Partial<Record<VastTrackingEvent, readonly string[]>> = {}
    for (const event of Object.keys(this.tracking) as VastTrackingEvent[]) {
      frozen[event] = (this.tracking[event] ?? []).slice()
    }
    return frozen
  }

  private resetAd(): void {
    this.adId = ''
    this.adSequence = null
    this.isWrapper = false
    this.impressions.length = 0
    this.errors.length = 0
    this.tagUri = null
    this.adSystem = null
    this.adTitle = null
    this.followAdditionalWrappers = true
    this.allowMultipleAds = false
    this.fallbackOnNoAd = null
    this.duration = 0
    this.skipOffset = null
    this.mediaFiles.length = 0
    this.clickThrough = null
    this.clickTracking.length = 0
    this.customClicks.length = 0
    this.tracking = {}
    this.progress.length = 0
    this.adServingId = null
    this.universalAdIds.length = 0
    this.pendingUniversalAdIdRegistry = null
    this.advertiser = null
    this.pricing = null
    this.pendingPricing = EMPTY
    this.categories.length = 0
    this.pendingCategoryAuthority = null
    this.expires = null
    this.sawViewableImpression = false
    this.viewableImpressionId = null
    this.viewable.length = 0
    this.notViewable.length = 0
    this.viewUndetermined.length = 0
    this.icons.length = 0
    this.insideIcon = false
    this.pendingIcon = EMPTY
    this.iconStaticResource = null
    this.iconStaticType = null
    this.iconClickThrough = null
    this.iconClickTracking.length = 0
    this.iconViewTracking.length = 0
    this.extensions.length = 0
    this.sawUnplayableCreative = false
    this.verifications.length = 0
    this.insideVerifications = false
    this.extensionIsVerifications = false
    this.verificationVendor = null
    this.verificationResources.length = 0
    this.verificationParameters = null
    this.verificationNotExecuted.length = 0
    this.pendingResource = EMPTY
  }
}

function append(value: string, list: string[]): void {
  const url = urlFrom(value)
  if (url !== null) list.push(url)
}

// MARK: - Scalars

/**
 * An element's attributes by qualified name. A `Map` rather than an object
 * literal, because the names are the response's and `__proto__` is a legal one.
 */
type Attributes = ReadonlyMap<string, string>

const EMPTY: Attributes = new Map()

/** VAST booleans appear as `true`/`false` and as `1`/`0`, interchangeably. */
function bool(value: string | undefined, fallback: boolean): boolean {
  switch (value === undefined ? undefined : trimSpacesAndTabs(value).toLowerCase()) {
    case 'true':
    case '1':
      return true
    case 'false':
    case '0':
      return false
    default:
      return fallback
  }
}

const INTEGER = /^[+-]?[0-9]+$/

/**
 * Swift's `Int(_:)`: an optional sign and digits, nothing else — no whitespace,
 * which is what makes `width=""` and `width=" 640"` absent rather than zero.
 * Out of 32-bit range is absent too, as it is for Kotlin's `toIntOrNull`.
 */
function integer(value: string): number | null {
  if (!INTEGER.test(value)) return null
  const parsed = Number(value)
  // `| 0` folds `-0` into `0`; the range check has already kept it exact.
  return parsed >= -2147483648 && parsed <= 2147483647 ? parsed | 0 : null
}

function optionalInteger(value: string | undefined): number | null {
  return value === undefined ? null : integer(value)
}

const DECIMAL = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/

/**
 * Swift's `Double(_:)` for the decimal forms a response uses. Stricter than
 * `Number()` or `parseFloat`, which also take whitespace, hex, `Infinity` or a
 * trailing remainder.
 */
function decimal(value: string): number | null {
  return DECIMAL.test(value) ? Number(value) : null
}

/** Hours, minutes and seconds. */
const TIMESTAMP_PARTS = 3

/** `HH:MM:SS` or `HH:MM:SS.mmm`. */
function seconds(value: string): number | null {
  // Swift's `split` drops empty pieces, so `00::10` is two parts, not three.
  const parts = value.split(':').filter((part) => part.length > 0)
  if (parts.length !== TIMESTAMP_PARTS) return null
  const hours = decimal(parts[0] ?? '')
  if (hours === null) return null
  const minutes = decimal(parts[1] ?? '')
  if (minutes === null) return null
  const secs = decimal(parts[2] ?? '')
  if (secs === null) return null
  return hours * 3600 + minutes * 60 + secs
}

function optionalSeconds(value: string | undefined): number | null {
  return value === undefined ? null : seconds(value)
}

/** A `skipoffset` or `progress` offset: a timestamp or a percentage. */
function offset(value: string): VastSkipOffset | null {
  const trimmed = trimSpacesAndTabs(value)
  if (trimmed.endsWith('%')) {
    const percent = decimal(trimmed.substring(0, trimmed.length - 1))
    if (percent !== null) return { type: 'percent', percent }
  }
  const time = seconds(trimmed)
  return time === null ? null : { type: 'time', seconds: time }
}

/** `<MediaFile delivery>`, matched exactly as the spec spells it. */
function delivery(name: string): VastDelivery | null {
  return name === 'progressive' || name === 'streaming' ? name : null
}

function trimSpacesAndTabs(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '')
}

function attributeMap(element: Element): Attributes {
  const map = new Map<string, string>()
  const attributes = element.attributes
  for (let index = 0; index < attributes.length; index++) {
    const attribute = attributes.item(index)
    if (attribute !== null) map.set(attribute.name, attribute.value)
  }
  return map
}

/**
 * Attributes of a raw-captured element, in a stable order. Sorted by name, as
 * the Apple parser writes them, so every SDK hands a host the same string.
 */
function attributeString(attributes: Attributes): string {
  const names = Array.from(attributes.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  let out = ''
  for (const name of names) out += ' ' + name + '="' + (attributes.get(name) ?? '') + '"'
  return out
}
