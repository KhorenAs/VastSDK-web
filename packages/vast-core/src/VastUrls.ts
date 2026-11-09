/**
 * How a URI read from a response is stored.
 *
 * The Apple SDK keeps URIs as Foundation `URL`s, and `URL(string:)` percent-
 * encodes what is not legal in a URI rather than refusing it — most importantly
 * the brackets of a macro, so `[ERRORCODE]` is stored as `%5BERRORCODE%5D`.
 * Keeping the same form here keeps every URI byte-identical across the three
 * SDKs, which is what lets one conformance suite check all of them. The WHATWG
 * `URL` parser would instead rewrite the URI (lower-casing the host, resolving
 * dot segments, encoding differently per component), so it is not used to store.
 */

/** Characters RFC 3986 never allows unencoded outside an IPv6 host. */
const ILLEGAL = ' "<>\\^`{|}[]'

const HEX = '0123456789ABCDEF'

const encoder = new TextEncoder()

/** `null` for an empty value: there is nothing to request. */
export function urlFrom(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return normaliseUrl(trimmed)
}

export function normaliseUrl(value: string): string {
  let out = ''
  let index = 0
  while (index < value.length) {
    const char = value.charAt(index)
    const code = value.charCodeAt(index)
    if (char === '%' && isEscape(value, index)) {
      out += char
    } else if (char === '%') {
      out += '%25'
    } else if (code <= 0x20 || code === 0x7f || ILLEGAL.includes(char)) {
      out += percentEncode(char)
    } else if (code > 0x7f) {
      // A surrogate pair is one code point and one UTF-8 sequence.
      const end = isHighSurrogate(code) && index + 1 < value.length ? index + 2 : index + 1
      out += percentEncode(value.substring(index, end))
      index = end
      continue
    } else {
      out += char
    }
    index++
  }
  return out
}

/** `%XX` for every UTF-8 byte of `text`, upper-case as RFC 3986 asks. */
export function percentEncode(text: string): string {
  let out = ''
  for (const byte of encoder.encode(text)) {
    out += '%' + HEX.charAt(byte >> 4) + HEX.charAt(byte & 0x0f)
  }
  return out
}

function isEscape(value: string, index: number): boolean {
  return index + 2 <= value.length - 1 && isHexDigit(value.charAt(index + 1)) && isHexDigit(value.charAt(index + 2))
}

function isHexDigit(char: string): boolean {
  return (char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
