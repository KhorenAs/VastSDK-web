import type { VastError } from './VastError.js'
import type { VastMacroValues } from './VastMacroValues.js'
import { normaliseUrl, percentEncode } from './VastUrls.js'
import type { VastNotExecutedReason } from './VastVerification.js'
import { VastVersion } from './VastVersion.js'

/**
 * What this player can tell the ad server about the moment being reported.
 *
 * Every field is optional because honesty is the point: a value left out is
 * reported as unknown rather than guessed at.
 */
export interface VastMacroContext {
  readonly errorCode?: VastError | null
  /**
   * Why a verification vendor's code did not run, for `[REASON]` on a
   * `verificationNotExecuted` tracker (§3.16). Unset on every other beacon.
   */
  readonly verificationNotExecutedReason?: VastNotExecutedReason | null
  /** Playhead within the ad creative, in seconds. */
  readonly adPlayhead?: number | null
  /** Playhead within the content the ad interrupted, in seconds. */
  readonly contentPlayhead?: number | null
  readonly assetUri?: string | null
  /** Milliseconds since the epoch. Defaults to the moment of expansion when absent. */
  readonly timestampMillis?: number | null
  /** Pinned in tests; a fresh random value otherwise. */
  readonly cacheBuster?: string | null
  /** A player size in pixels, for `[PLAYERSIZE]`. */
  readonly playerSize?: { readonly width: number; readonly height: number } | null
  readonly isMuted?: boolean | null
  readonly isFullscreen?: boolean | null
  readonly appBundle?: string | null
  /**
   * The page the player sits on, for `[PAGEURL]` and `[DOMAIN]` — the web's
   * answer to `[APPBUNDLE]`, and as much the first thing an exchange prices on.
   * Supplied by the session (`location.href`); the expander reads no browser
   * state of its own.
   */
  readonly pageUrl?: string | null
  /**
   * Vendors named in the ad's `<AdVerifications>`. Reported as unknown while
   * empty, which is the difference between "nobody asked" and "somebody
   * asked and we are not saying".
   */
  readonly verificationVendors?: readonly string[]
  /** The OMID partner name and version, when a measurement integration is present to have one. */
  readonly omidPartner?: string | null
  /** Vendor macros this SDK knows nothing about, supplied by the host. Keyed without brackets. */
  readonly custom?: Readonly<Record<string, string>>
  /**
   * Everything only the host can answer — identifier, consent, where the
   * break sits. Unset values report `-1`, which is what §6 means by
   * "unknown" and an honest thing to say.
   */
  readonly host?: VastMacroValues
  /** The MIME type of the creative being played, for `[MEDIAMIME]`. */
  readonly mediaMimeType?: string | null
  /**
   * `[TRANSACTIONID]` — one value for one break, so an ad server can tie this
   * request's beacons together.
   */
  readonly transactionId?: string | null
  /**
   * Whether something will execute the ad's verification code, which is what
   * `[APIFRAMEWORKS]` is being asked about. Default `false`.
   */
  readonly executesOmid?: boolean
}

/**
 * Substitutes VAST 4.3 §6 macros into a tracking URI.
 *
 * Three rules from the spec drive the whole implementation:
 *
 * - A macro is its name *including* the brackets, and the whole thing is
 *   replaced: `?e=[ERRORCODE]` becomes `?e=403`, not `?e=[403]`.
 * - `encodeURIComponent` is applied to each **value**, not to the finished
 *   string — so a comma separating two array values stays a comma while a comma
 *   inside one value does not.
 * - A macro the spec defines but this player does not supply becomes `-1`
 *   (unknown) or `-2` (known but withheld). A macro the spec does *not* define is
 *   left exactly as it was: "do not replace all unknown macros with -1".
 */
export class VastMacroExpander {
  /**
   * Expands a URI held as a request target, as the session does before sending
   * a beacon.
   *
   * Any bracket still standing afterwards belongs to a macro this player left
   * alone — a vendor's own. Brackets are not legal in a query, so they are
   * re-encoded, and only they are: every other escape is left exactly as it
   * was, so a value already encoded correctly is never encoded twice.
   */
  expandUrl(url: string, context: VastMacroContext): string {
    return this.expand(url, context).replace(/\[/g, '%5B').replace(/\]/g, '%5D')
  }

  /**
   * String form, so a caller holding a template rather than a request target —
   * and the tests — can use the same code path. Unexpanded brackets are left as
   * text here; only {@link expandUrl} re-encodes them.
   */
  expand(string: string, context: VastMacroContext): string {
    const source = VastMacroExpander.normalisingEncodedBrackets(string)
    let result = ''
    let index = 0

    for (;;) {
      const open = source.indexOf('[', index)
      if (open < 0) break
      result += source.substring(index, open)

      const close = source.indexOf(']', open + 1)
      if (close < 0) {
        // An unbalanced bracket is just text.
        return result + source.substring(open)
      }

      const name = source.substring(open + 1, close)
      result += this.replacement(name, context) ?? source.substring(open, close + 1)
      index = close + 1
    }

    return result + source.substring(index)
  }

  // MARK: - Values

  /** `null` means "leave the macro alone" — it is not one the spec defines. */
  private replacement(name: string, context: VastMacroContext): string | null {
    const encode = VastMacroExpander.encode
    const unknown = VastMacroExpander.UNKNOWN_VALUE

    const custom = ownValue(context.custom, name)
    if (custom !== null) return encode(custom)
    const host = context.host ?? {}
    const hostCustom = ownValue(host.custom, name)
    if (hostCustom !== null) return encode(hostCustom)

    switch (name) {
      case 'ERRORCODE':
        return orUnknown(context.errorCode, String)

      case 'REASON':
        return orUnknown(context.verificationNotExecutedReason, String)

      case 'VERIFICATIONVENDORS': {
        const vendors = context.verificationVendors ?? []
        return vendors.length === 0 ? unknown : encode(vendors.join(','))
      }

      case 'OMIDPARTNER':
        return orUnknown(context.omidPartner, encode)

      // MEDIAPLAYHEAD is the pre-4.1 spelling of the same value.
      case 'ADPLAYHEAD':
      case 'MEDIAPLAYHEAD':
        return orUnknown(context.adPlayhead, (seconds) => encode(VastMacroExpander.timecode(seconds)))

      case 'CONTENTPLAYHEAD':
        return orUnknown(context.contentPlayhead, (seconds) => encode(VastMacroExpander.timecode(seconds)))

      // The stored form of the URI, as the Apple SDK's `absoluteString` is, so a
      // space already written as `%20` is encoded once more and nowhere else.
      case 'ASSETURI':
        return orUnknown(context.assetUri, (uri) => encode(normaliseUrl(uri)))

      case 'TIMESTAMP':
        return encode(VastMacroExpander.iso8601(context.timestampMillis ?? Date.now()))

      // Always answerable, and the whole point is that it differs per request.
      case 'CACHEBUSTING':
        return context.cacheBuster ?? VastMacroExpander.randomCacheBuster()

      case 'PLAYERSTATE':
        return encode(this.playerState(context))

      // An array macro: values are comma separated and the comma is not encoded.
      case 'PLAYERSIZE':
        return orUnknown(context.playerSize, (size) => `${size.width},${size.height}`)

      case 'APPBUNDLE':
        return orUnknown(context.appBundle, encode)

      case 'PAGEURL':
        return orUnknown(context.pageUrl, encode)

      case 'DOMAIN':
        return orUnknown(hostOf(context.pageUrl), encode)

      // MARK: Host-supplied

      case 'IFA':
        return orUnknown(host.identifierForAdvertising, encode)

      case 'IFATYPE':
        return orUnknown(host.identifierType, encode)

      // Reported as the spec's booleans, and only when it is known: `false`
      // and "nobody asked" are different facts about a viewer.
      case 'LIMITADTRACKING':
        return orUnknown(host.limitsAdTracking, (limits) => (limits ? '1' : '0'))

      // Already base64url by the time a CMP produces it, so encoding it again
      // would corrupt it.
      case 'GDPRCONSENT':
        return host.gdprConsent ?? unknown

      case 'REGULATIONS':
        return orUnknown(host.regulations, encode)

      case 'DEVICEUA':
        return orUnknown(host.deviceUserAgent, encode)

      case 'PLACEMENTTYPE':
        return orUnknown(host.placementType, String)

      case 'BREAKPOSITION':
        return orUnknown(host.breakPosition, String)

      case 'CONTENTID':
        return orUnknown(host.contentId, encode)

      case 'CONTENTURI':
        return orUnknown(host.contentUri, (uri) => encode(normaliseUrl(uri)))

      // MARK: Answerable by the SDK itself

      case 'MEDIAMIME':
        return orUnknown(context.mediaMimeType, encode)

      case 'TRANSACTIONID':
        return orUnknown(context.transactionId, encode)

      // 0 is "the client made this request", which is always true here: there
      // is no server-side stitching in this SDK to be unsure about.
      case 'SERVERSIDE':
        return '0'

      // The only creative this SDK plays is a Linear video.
      case 'ADTYPE':
        return 'video'

      // The spec's `name/version` form, naming the SDK rather than the app:
      // the app is `[APPBUNDLE]`, and conflating the two loses both. The same
      // name as the Apple and Android SDKs; the version tells them apart.
      case 'CLIENTUA':
        return encode(`VASTSDK/${VastVersion.CURRENT}`)

      // What the parser accepts, not what this document happens to be.
      case 'VASTVERSIONS':
        return VastMacroExpander.SUPPORTED_VAST_VERSIONS

      // 7 is OMID-1 in AdCOM's list, and it is only true when something is
      // actually there to execute a vendor's code. Claiming it otherwise would
      // tell a verification vendor to expect a session that never starts.
      case 'APIFRAMEWORKS':
        return context.executesOmid === true ? '7' : unknown

      // Defined by the spec but not supplied: report unknown. Not defined by
      // the spec: leave it for whoever put it there.
      default:
        return VastMacroExpander.SPEC_DEFINED.has(name) ? unknown : null
    }
  }

  /** `PLAYERSTATE` is an array of flags; an empty state is still an answer. */
  private playerState(context: VastMacroContext): string {
    const flags: string[] = []
    if (context.isMuted === true) flags.push('muted')
    if (context.isFullscreen === true) flags.push('fullscreen')
    return flags.join(',')
  }

  /** Reported for a value that is known but must not be shared. */
  static readonly WITHHELD_VALUE: string = '-2'

  /**
   * Reported for a macro the spec defines but this player does not know.
   * @internal
   */
  static readonly UNKNOWN_VALUE: string = '-1'

  /**
   * The VAST versions the parser accepts, for `[VASTVERSIONS]`.
   *
   * A list rather than one number: the parser is deliberately version-
   * tolerant, and an ad server that knows it may send VAST 2 will send its
   * VAST 2.
   * @internal
   */
  static readonly SUPPORTED_VAST_VERSIONS: string = '2,3,4,4.1,4.2,4.3'

  /**
   * Macros §6 defines. Only these become `-1` when unsupplied; anything else is somebody's vendor extension.
   * @internal
   */
  static readonly SPEC_DEFINED: ReadonlySet<string> = new Set([
    'ERRORCODE', 'ADPLAYHEAD', 'MEDIAPLAYHEAD', 'CONTENTPLAYHEAD',
    'ASSETURI', 'TIMESTAMP', 'CACHEBUSTING', 'PLAYERSTATE',
    'PLAYERSIZE', 'PLAYERCAPABILITIES', 'APPBUNDLE', 'DOMAIN',
    'PAGEURL', 'IFA', 'IFATYPE', 'CLIENTUA', 'DEVICEUA', 'DEVICEIP',
    'SERVERSIDE', 'ADTYPE', 'ADCATEGORIES', 'BREAKPOSITION',
    'BLOCKEDADCATEGORIES', 'CLICKTYPE', 'GDPRCONSENT', 'LIMITADTRACKING',
    'REGULATIONS', 'TRANSACTIONID', 'PLACEMENTTYPE', 'INVENTORYSTATE',
    'CONTENTID', 'CONTENTURI', 'MEDIAMIME', 'OMIDPARTNER', 'VASTVERSIONS',
    'APIFRAMEWORKS', 'EXTENSIONS', 'VERIFICATIONVENDORS', 'REASON',
  ])

  /**
   * Restores brackets that became `%5B`/`%5D`.
   *
   * URIs are stored with their brackets encoded (see `VastAd`), so a macro
   * arrives here as `%5BERRORCODE%5D`. Scanning for `[` alone would find
   * nothing, and every macro would go out unexpanded — silently, because the
   * URI still looks plausible.
   *
   * Only bracket pairs wrapping a macro-shaped name are touched, so an
   * encoded bracket that is genuinely part of a value is left as it is.
   * @internal
   */
  static normalisingEncodedBrackets(string: string): string {
    if (!/%5B/i.test(string)) return string
    return string.replace(ENCODED_MACRO, '[$1]')
  }

  /**
   * `HH:MM:SS.mmm`, the form §6 specifies for playhead values.
   * @internal
   */
  static timecode(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00.000'
    const total = Math.trunc(seconds)
    const milliseconds = Math.trunc((seconds - total) * 1000)
    const hours = Math.trunc(total / 3600)
    const minutes = Math.trunc((total % 3600) / 60)
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(total % 60, 2)}.${pad(milliseconds, 3)}`
  }

  /**
   * Internet date-time in UTC, as Foundation's `.withInternetDateTime` writes
   * it: whole seconds and a `Z`, no fraction and no numeric offset.
   * @internal
   */
  static iso8601(epochMillis: number): string {
    const date = new Date(epochMillis)
    const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`
    const time = `${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`
    return `${day}T${time}Z`
  }

  /** @internal */
  static randomCacheBuster(): string {
    return pad(Math.floor(Math.random() * CACHE_BUSTER_LIMIT), 8)
  }

  /**
   * Percent-encodes one value. Applied per value rather than to the finished
   * URI, which is what keeps array separators intact. Everything outside
   * RFC 3986's unreserved set is encoded, so `&`, `=`, `+` and `?` cannot
   * break the query a value is placed into — which is also why this is not
   * `encodeURIComponent`, which leaves `!'()*` alone.
   * @internal
   */
  static encode(value: string): string {
    let out = ''
    // By code point, so a character outside the BMP is one UTF-8 sequence.
    for (const char of value) {
      out += UNRESERVED.test(char) ? char : percentEncode(char)
    }
    return out
  }
}

const ENCODED_MACRO = /%5B([A-Za-z0-9_]+)%5D/gi

/** Eight digits, the width `%08d` writes. */
const CACHE_BUSTER_LIMIT = 100_000_000

/** RFC 3986's unreserved set: ASCII letters and digits, and `-._~`. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/

/** `transform(value)`, or `-1` when the value was not supplied. */
function orUnknown<T>(value: T | null | undefined, transform: (value: T) => string): string {
  return value === null || value === undefined ? VastMacroExpander.UNKNOWN_VALUE : transform(value)
}

/**
 * A host-supplied vendor value. Own keys only: `[constructor]` in a tag is a
 * vendor's macro, not `Object.prototype`'s.
 */
function ownValue(record: Readonly<Record<string, string>> | undefined, key: string): string | null {
  if (record === undefined || !Object.prototype.hasOwnProperty.call(record, key)) return null
  return record[key] ?? null
}

/**
 * The host of a page URL, for `[DOMAIN]`. Read by hand rather than with the
 * WHATWG `URL` parser so `vast-core` stays free of anything a browser would
 * have to supply; `null` (reported as unknown) for anything without one.
 */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/.exec(url)
  const host = match?.[1]
  return host ? host.toLowerCase() : null
}

/** Zero-padded to `width` digits, as `%0Nd` writes it. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}
