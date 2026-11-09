/**
 * The §6 macro values only the host can supply.
 *
 * Every one of these is something the SDK must not decide for itself. An
 * advertising identifier requires the host to have asked the viewer for
 * permission; a consent string comes from a CMP the host chose; whether this
 * break is a pre-roll is a fact about the host's own timeline. The SDK reporting
 * a guess in any of those places would be worse than reporting nothing, which is
 * what an unsupplied macro does — §6 gives it `-1`, meaning "not known".
 *
 * Left empty, every macro here goes out as `-1`. That is the correct default and
 * also a real cost: an ad server with no `IFA` and no `PAGEURL` will often not
 * bid at all. Filling these in is the difference between a request an exchange
 * can price and one it cannot.
 *
 * Every field is optional; an absent one is "not known".
 */
export interface VastMacroValues {
  /**
   * `[IFA]` — an advertising identifier, if the host has permission to use one.
   * Browsers have no device advertising ID; a web host that has one (a
   * first-party ID with the viewer's consent) passes it here, otherwise leave
   * it out rather than sending a zeroed identifier.
   */
  readonly identifierForAdvertising?: string | null
  /**
   * `[IFATYPE]` — what kind of identifier `identifierForAdvertising` is, in the
   * vendor-agnostic spelling the spec asks for, e.g. `ppid` or `sessionid`.
   */
  readonly identifierType?: string | null
  /** `[LIMITADTRACKING]` — whether the viewer asked not to be tracked. Absent means unknown, which is different from `false`. */
  readonly limitsAdTracking?: boolean | null
  /** `[GDPRCONSENT]` — the IAB TCF consent string, straight from the CMP. */
  readonly gdprConsent?: string | null
  /** `[REGULATIONS]` — which regimes apply to this request, e.g. `gdpr` or `coppa`. */
  readonly regulations?: string | null
  /**
   * `[DEVICEUA]` — the browser's user agent.
   *
   * The expander never reads `navigator` itself — `vast-core` touches no
   * browser state. `vast-kit`'s session fills this from `navigator.userAgent`
   * when the host leaves it out: unlike a native app, a browser has an honest
   * one to give.
   */
  readonly deviceUserAgent?: string | null
  /** `[PLACEMENTTYPE]` — where the player sits, in AdCOM's numbering. */
  readonly placementType?: number | null
  /**
   * `[BREAKPOSITION]` — 1 pre-roll, 2 mid-roll, 3 post-roll, 0 unknown.
   *
   * The SDK cannot know this: it is handed one break at a time and never sees
   * the content timeline that decides where the break sits.
   */
  readonly breakPosition?: number | null
  /** `[CONTENTID]` — the host's own identifier for what the ad interrupted. */
  readonly contentId?: string | null
  /** `[CONTENTURI]` — where that content came from. */
  readonly contentUri?: string | null
  /**
   * Vendor macros this SDK knows nothing about.
   *
   * Keyed without brackets: `{ CORRELATOR: '1234' }` replaces `[CORRELATOR]`.
   * Anything §6 does not define is left alone when it is not here, because the
   * spec is explicit that unknown macros must not all become `-1`.
   */
  readonly custom?: Readonly<Record<string, string>>
}
