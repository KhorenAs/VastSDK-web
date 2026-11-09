/**
 * The VAST 4.3 §2.3.6.3 error table.
 *
 * The value is the code itself — what replaces the `[ERRORCODE]` macro in an
 * `<Error>` URI — so `VastError.MEDIA_FILE_NOT_FOUND === 401`.
 */
export const VastError = {
  // Document
  XML_PARSING: 100,
  SCHEMA_VALIDATION: 101,
  VERSION_NOT_SUPPORTED: 102,

  // Trafficking
  TRAFFICKING: 200,
  UNEXPECTED_LINEARITY: 201,
  UNEXPECTED_DURATION: 202,
  UNEXPECTED_SIZE: 203,
  AD_CATEGORY_MISSING: 204,
  AD_CATEGORY_BLOCKED: 205,
  AD_BREAK_SHORTENED: 206,

  // Wrapper
  WRAPPER_GENERAL: 300,
  WRAPPER_TIMEOUT: 301,
  WRAPPER_LIMIT_REACHED: 302,
  NO_VAST_RESPONSE_AFTER_WRAPPERS: 303,
  IN_LINE_TIMEOUT: 304,

  // Linear
  LINEAR_GENERAL: 400,
  MEDIA_FILE_NOT_FOUND: 401,
  MEDIA_FILE_TIMEOUT: 402,
  NO_SUPPORTED_MEDIA_FILE: 403,
  MEDIA_FILE_DISPLAY_PROBLEM: 405,
  MEZZANINE_MISSING: 406,
  MEZZANINE_DOWNLOADING: 407,
  CONDITIONAL_AD_REJECTED: 408,
  INTERACTIVE_UNIT_NOT_EXECUTED: 409,
  VERIFICATION_NOT_EXECUTED: 410,
  MEZZANINE_BELOW_SPEC: 411,

  // NonLinear / Companion — parsed and reported, never played by this SDK.
  NON_LINEAR_GENERAL: 500,
  NON_LINEAR_DIMENSIONS: 501,
  NON_LINEAR_FETCH_FAILED: 502,
  NON_LINEAR_UNSUPPORTED_TYPE: 503,
  COMPANION_GENERAL: 600,
  COMPANION_DIMENSIONS: 601,
  COMPANION_REQUIRED_NOT_SHOWN: 602,
  COMPANION_FETCH_FAILED: 603,
  COMPANION_UNSUPPORTED_TYPE: 604,

  UNDEFINED: 900,
  VPAID_GENERAL: 901,
  INTERACTIVE_CREATIVE_FILE: 902,
} as const

export type VastErrorName = keyof typeof VastError
export type VastError = (typeof VastError)[VastErrorName]

const NAMES = new Map<number, VastErrorName>(
  (Object.keys(VastError) as VastErrorName[]).map((name) => [VastError[name], name]),
)

/** The table's name for a code, e.g. `401` → `"MEDIA_FILE_NOT_FOUND"`. */
export function vastErrorName(error: VastError): VastErrorName {
  return NAMES.get(error) ?? 'UNDEFINED'
}

/** The error a code names, or `null` for a code the table does not define. */
export function vastErrorFromCode(code: number): VastError | null {
  return NAMES.has(code) ? (code as VastError) : null
}

/** A {@link VastError} raised as an exception, for the calls that throw one. */
export class VastException extends Error {
  override readonly name = 'VastException'

  constructor(
    readonly error: VastError,
    options?: { cause?: unknown },
  ) {
    super(`VAST error ${error} ${vastErrorName(error)}`)
    // `cause` is ES2022; set by hand so the ES2017 build keeps it.
    if (options && 'cause' in options) {
      Object.defineProperty(this, 'cause', { value: options.cause, configurable: true, writable: true })
    }
  }
}
