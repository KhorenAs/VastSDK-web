import { describe, expect, it } from 'vitest'
import { VastError } from '../src/VastError.js'
import { VastMacroExpander } from '../src/VastMacroExpander.js'
import { normaliseUrl } from '../src/VastUrls.js'
import { VastVersion } from '../src/VastVersion.js'

/**
 * VAST 4.3 §6. The rules are short but each has a way of going wrong that is
 * invisible until an ad server reports nonsense.
 */
describe('VastMacroExpander', () => {
  const expander = new VastMacroExpander()

  /** A URI as the parser stores it, brackets encoded — the form every beacon actually has. */
  const stored = (uri: string) => normaliseUrl(uri)

  // MARK: - Replacement

  /** The brackets are part of the macro and go with it. */
  it('macroIsReplacedIncludingItsBrackets', () => {
    const result = expander.expand('https://ads.test/e?code=[ERRORCODE]', { errorCode: VastError.NO_SUPPORTED_MEDIA_FILE })
    expect(result).toBe('https://ads.test/e?code=403')
  })

  /** The bug the whole file exists to prevent: an unexpanded macro reaches the ad server as text. */
  it('errorCodeIsNeverLeftAsLiteralText', () => {
    const result = expander.expand('https://ads.test/e?code=[ERRORCODE]', { errorCode: VastError.WRAPPER_LIMIT_REACHED })
    expect(result).not.toContain('[ERRORCODE]')
    expect(result.endsWith('=302')).toBe(true)
  })

  it('severalMacrosInOneUri', () => {
    const result = expander.expand('https://ads.test/t?p=[ADPLAYHEAD]&cb=[CACHEBUSTING]&e=[ERRORCODE]', {
      errorCode: VastError.MEDIA_FILE_TIMEOUT,
      adPlayhead: 12.5,
      cacheBuster: '12345678',
    })
    expect(result).toBe('https://ads.test/t?p=00%3A00%3A12.500&cb=12345678&e=402')
  })

  // MARK: - Unknown values

  /** §6: a macro the spec defines but the player does not supply is `-1`. */
  it('specMacroWithNoValueBecomesMinusOne', () => {
    expect(expander.expand('https://ads.test/t?p=[ADPLAYHEAD]', {})).toBe('https://ads.test/t?p=-1')
  })

  /**
   * §6, verbatim: "do not replace all unknown macros with -1, only do this for
   * macros specifically mentioned in this section".
   */
  it('macroTheSpecDoesNotDefineIsLeftUntouched', () => {
    expect(expander.expand('https://ads.test/t?x=[ADFOX_SOMETHING]', {})).toBe('https://ads.test/t?x=[ADFOX_SOMETHING]')
  })

  it('hostSuppliedCustomMacroIsSubstituted', () => {
    const result = expander.expand('https://ads.test/t?x=[ADFOX_SOMETHING]', { custom: { ADFOX_SOMETHING: 'kinodaran' } })
    expect(result).toBe('https://ads.test/t?x=kinodaran')
  })

  // MARK: - Encoding

  /** §6: encode each value, not the finished string — otherwise the `?` and `&` that make the URI a URI get encoded too. */
  it('valuesAreEncodedButTheUriStructureIsNot', () => {
    const result = expander.expand('https://ads.test/t?asset=[ASSETURI]&next=1', { assetUri: 'https://cdn.test/a b.mp4?v=2&x=3' })
    expect(result.startsWith('https://ads.test/t?asset=')).toBe(true)
    expect(result.endsWith('&next=1'), "the URI's own separators survived").toBe(true)
    expect(result, "the value's own '?' was encoded").toContain('%3F')
    expect(result, "the value's own '&' was encoded").toContain('%26')
  })

  /** An array macro separates values with commas, and those commas stay commas. */
  it('arrayMacroKeepsItsSeparators', () => {
    const result = expander.expand('https://ads.test/t?size=[PLAYERSIZE]', { playerSize: { width: 1280, height: 720 } })
    expect(result).toBe('https://ads.test/t?size=1280,720')
  })

  it('playerStateReportsFlagsAsAnArray', () => {
    expect(expander.expand('[PLAYERSTATE]', { isMuted: true, isFullscreen: true })).toBe('muted%2Cfullscreen')
    expect(
      expander.expand('[PLAYERSTATE]', { isMuted: false, isFullscreen: false }),
      'no flags is still an answer, not unknown',
    ).toBe('')
  })

  // MARK: - Formats

  /** §6 specifies `HH:MM:SS.mmm` for playhead values. */
  it('playheadUsesTheSpecifiedTimeFormat', () => {
    expect(VastMacroExpander.timecode(0.0)).toBe('00:00:00.000')
    expect(VastMacroExpander.timecode(12.5)).toBe('00:00:12.500')
    expect(VastMacroExpander.timecode(3661.25)).toBe('01:01:01.250')
  })

  /** `MEDIAPLAYHEAD` is the older spelling of `ADPLAYHEAD`; a server using either must get the same answer. */
  it('mediaPlayheadIsTreatedAsTheAdPlayhead', () => {
    const context = { adPlayhead: 7.0 }
    expect(expander.expand('[MEDIAPLAYHEAD]', context)).toBe(expander.expand('[ADPLAYHEAD]', context))
  })

  it('timestampIsIso8601', () => {
    const result = expander.expand('[TIMESTAMP]', { timestampMillis: 0 })
    expect(result, "Foundation's internet date-time, in UTC").toBe('1970-01-01T00%3A00%3A00Z')
  })

  /** Cache busting is always answerable, and differing per request is the point. */
  it('cacheBustingIsGeneratedWhenNotSupplied', () => {
    const first = expander.expand('[CACHEBUSTING]', {})
    expect(first).not.toBe(VastMacroExpander.UNKNOWN_VALUE)
    expect(first.length).toBe(8)
  })

  // MARK: - Robustness

  /** A stray bracket in a URI is text, not a malformed macro. */
  it('unbalancedBracketIsLeftAlone', () => {
    expect(expander.expand('https://ads.test/t?x=[oops', {})).toBe('https://ads.test/t?x=[oops')
  })

  it('uriWithNoMacrosIsUnchanged', () => {
    const plain = 'https://ads.test/impression?id=42'
    expect(expander.expand(plain, {})).toBe(plain)
  })

  it('expandingAStoredUriReplacesItsMacro', () => {
    expect(expander.expandUrl(stored('https://ads.test/t?e=[ERRORCODE]'), { errorCode: VastError.UNDEFINED })).toBe(
      'https://ads.test/t?e=900',
    )
  })

  // MARK: - Percent-encoded brackets

  it('macroSurvivesHavingBeenStoredAsAUri', () => {
    const uri = stored('https://ads.test/e?code=[ERRORCODE]')
    expect(uri, 'precondition: the stored form encodes the brackets, which is the whole problem').toContain('%5B')
    expect(expander.expandUrl(uri, { errorCode: VastError.NO_SUPPORTED_MEDIA_FILE })).toBe('https://ads.test/e?code=403')
  })

  it('encodedBracketsAreRecognisedInStringForm', () => {
    expect(expander.expand('https://ads.test/e?code=%5BERRORCODE%5D', { errorCode: VastError.WRAPPER_TIMEOUT })).toBe(
      'https://ads.test/e?code=301',
    )
  })

  /** Lower-case escapes are just as valid. */
  it('lowercaseEncodedBracketsAreRecognised', () => {
    expect(expander.expand('https://ads.test/e?code=%5bERRORCODE%5d', { errorCode: VastError.UNDEFINED })).toBe(
      'https://ads.test/e?code=900',
    )
  })

  /** An encoded bracket that is not wrapping a macro name stays encoded. */
  it('encodedBracketThatIsNotAMacroIsLeftAlone', () => {
    expect(expander.expand('https://ads.test/t?q=%5Bnot%20a%20macro%5D', {})).toBe('https://ads.test/t?q=%5Bnot%20a%20macro%5D')
  })

  // MARK: - No double encoding

  /**
   * Regression. A vendor macro left in place keeps its brackets, and re-encoding
   * the whole string would turn a correctly encoded `%3A` into `%253A`.
   */
  it('valuesAreNotEncodedTwiceWhenAVendorMacroRemains', () => {
    const expanded = expander.expandUrl(stored('https://ads.test/e?t=[TIMESTAMP]&x=[VENDOR_THING]'), {
      timestampMillis: 1_700_000_000_000,
    })

    expect(expanded, 'the value is encoded once').toContain('%3A')
    expect(expanded, 'and not a second time').not.toContain('%253A')
    expect(expanded, 'the vendor macro survives').toContain('%5BVENDOR_THING%5D')
  })

  it('assetUriIsEncodedExactlyOnce', () => {
    const expanded = expander.expandUrl(stored('https://ads.test/e?a=[ASSETURI]&x=[VENDOR]'), {
      assetUri: 'https://cdn.test/a.mp4',
    })

    expect(expanded).toContain('https%3A%2F%2Fcdn.test%2Fa.mp4')
    expect(expanded).not.toContain('%25')
  })

  // MARK: - What only the host can answer

  it('theHostsIdentifierReachesTheServer', () => {
    const values = { identifierForAdvertising: 'AAAA-BBBB', identifierType: 'aaid', limitsAdTracking: false }
    const expanded = expander.expand('https://ads.test/i?ifa=[IFA]&t=[IFATYPE]&lmt=[LIMITADTRACKING]', { host: values })
    expect(expanded).toBe('https://ads.test/i?ifa=AAAA-BBBB&t=aaid&lmt=0')
  })

  /** `false` and "nobody asked" are different facts about a viewer. */
  it('anUnknownTrackingPreferenceIsNotReportedAsPermission', () => {
    expect(expander.expand('https://ads.test/i?lmt=[LIMITADTRACKING]', { host: {} })).toBe('https://ads.test/i?lmt=-1')
  })

  /** A TCF string is already base64url when the CMP hands it over. */
  it('theConsentStringIsPassedThroughUntouched', () => {
    const consent = 'CPcqBNVPcqBNVABCDEF_gABABCAAA-AAAAAAAAAAAA'
    const expanded = expander.expand('https://ads.test/i?gdpr_consent=[GDPRCONSENT]', { host: { gdprConsent: consent } })
    expect(expanded.endsWith(consent), 'the consent string was re-encoded').toBe(true)
  })

  it('whereTheBreakSitsComesFromTheHost', () => {
    const expanded = expander.expand('https://ads.test/i?pos=[BREAKPOSITION]&plcmt=[PLACEMENTTYPE]&cid=[CONTENTID]', {
      host: { placementType: 2, breakPosition: 1, contentId: 'show-42' },
    })
    expect(expanded).toBe('https://ads.test/i?pos=1&plcmt=2&cid=show-42')
  })

  // MARK: - What the SDK can answer itself

  it('theSdkAnswersWhatItKnowsAboutItself', () => {
    const expanded = expander.expand('https://ads.test/i?ss=[SERVERSIDE]&type=[ADTYPE]&mime=[MEDIAMIME]&tx=[TRANSACTIONID]', {
      mediaMimeType: 'video/mp4',
      transactionId: 'abc-123',
    })
    expect(expanded).toBe('https://ads.test/i?ss=0&type=video&mime=video%2Fmp4&tx=abc-123')
  })

  /** `[CLIENTUA]` names the SDK and `[APPBUNDLE]` names the app. */
  it('theClientUserAgentNamesTheSdkNotTheApp', () => {
    const expanded = expander.expand('https://ads.test/i?ua=[CLIENTUA]&app=[APPBUNDLE]', { appBundle: 'com.kinodaran.app' })
    expect(expanded).toContain(`VASTSDK%2F${VastVersion.CURRENT}`)
    expect(expanded).toContain('app=com.kinodaran.app')
  })

  // MARK: - The web's own (no Kotlin counterpart)

  /** `[PAGEURL]` and `[DOMAIN]` are the web's `[APPBUNDLE]`: the first thing an exchange prices on. */
  it('thePageIsReportedEncodedAndItsDomainOnItsOwn', () => {
    const expanded = expander.expand('https://ads.test/i?url=[PAGEURL]&d=[DOMAIN]', {
      pageUrl: 'https://Kinodaran.com/movie/1?lang=hy#t=10',
    })
    expect(expanded).toBe('https://ads.test/i?url=https%3A%2F%2FKinodaran.com%2Fmovie%2F1%3Flang%3Dhy%23t%3D10&d=kinodaran.com')
  })

  it('anUnknownPageIsMinusOneForBoth', () => {
    expect(expander.expand('https://ads.test/i?url=[PAGEURL]&d=[DOMAIN]', {})).toBe('https://ads.test/i?url=-1&d=-1')
    expect(expander.expand('https://ads.test/i?d=[DOMAIN]', { pageUrl: 'about:blank' })).toBe('https://ads.test/i?d=-1')
  })

  it('everyParsableVastVersionIsAdvertised', () => {
    expect(expander.expand('https://ads.test/i?v=[VASTVERSIONS]', {})).toBe('https://ads.test/i?v=2,3,4,4.1,4.2,4.3')
  })

  /** OMID is claimed only when something is actually there to run a vendor's code. */
  it('omidIsClaimedOnlyWhenSomethingWillRunIt', () => {
    expect(expander.expand('[APIFRAMEWORKS]', { executesOmid: false })).toBe('-1')
    expect(expander.expand('[APIFRAMEWORKS]', { executesOmid: true })).toBe('7')
  })

  it('playerSizeIsAnArrayWithItsCommaIntact', () => {
    expect(expander.expand('https://ads.test/i?size=[PLAYERSIZE]', { playerSize: { width: 1170, height: 658 } })).toBe(
      'https://ads.test/i?size=1170,658',
    )
  })

  /** A spec macro nobody supplied says so, while a vendor's macro is left exactly as it was. */
  it('unsuppliedSpecMacrosSayUnknownAndVendorMacrosAreLeftAlone', () => {
    // Left as text here, because this is the string form. Only `expandUrl`
    // re-encodes the brackets.
    expect(expander.expand('https://ads.test/i?ifa=[IFA]&dev=[DEVICEUA]&own=[CORRELATOR]', {})).toBe(
      'https://ads.test/i?ifa=-1&dev=-1&own=[CORRELATOR]',
    )
    expect(expander.expandUrl('https://ads.test/i?own=%5BCORRELATOR%5D', {})).toBe('https://ads.test/i?own=%5BCORRELATOR%5D')
  })

  it('vendorMacrosInTheSessionHostValuesAreExpanded', () => {
    const context = { host: { custom: { kinodaran_request_id: 'a b' } } }
    expect(expander.expand('https://ads.test/[kinodaran_request_id]', context)).toBe('https://ads.test/a%20b')
  })

  it('perExpansionVendorValuesOverrideSessionHostValues', () => {
    const context = { custom: { vendor: 'new' }, host: { custom: { vendor: 'old' } } }
    expect(expander.expand('[vendor]', context)).toBe('new')
  })
})
