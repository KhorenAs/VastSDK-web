/**
 * The ad UI's own words.
 *
 * Shipped in English and Armenian — the same strings, and the same keys, as the
 * Apple SDK's `Localizable.strings` — so a host that configures nothing gets
 * neither an English skip control on an Armenian page nor an empty one. A host
 * with more languages passes its own.
 */
export interface VastStrings {
  /** The badge while an ad is on screen, when the break holds one ad. */
  readonly adBadge: string
  /** The same badge in a pod: position, then how many ads the break holds. */
  readonly adBadgePod: (index: number, total: number) => string
  /** Time left in the creative. Kept short: it sits beside the badge. */
  readonly countdown: (seconds: number) => string
  /** The skip control, once `skipoffset` has elapsed. */
  readonly skipAction: string
  /** The skip control before it unlocks: seconds remaining. */
  readonly skipCountdown: (seconds: number) => string
  /** The control that opens the advertiser's page. */
  readonly learnMore: string
  /** Offered when the browser started the ad muted. */
  readonly unmute: string
  /** The media controls' name for an ad, when the response carried no `<AdTitle>`. */
  readonly nowPlayingTitle: string
}

export const VAST_STRINGS_EN: VastStrings = {
  adBadge: 'Ad',
  adBadgePod: (index, total) => `Ad ${index}/${total}`,
  countdown: (seconds) => `${seconds}s`,
  skipAction: 'Skip Ad  ›',
  skipCountdown: (seconds) => `Skip in ${seconds}`,
  learnMore: 'Learn more',
  unmute: 'Tap to unmute',
  nowPlayingTitle: 'Advertisement',
}

export const VAST_STRINGS_HY: VastStrings = {
  adBadge: 'Գովազդ',
  adBadgePod: (index, total) => `Գովազդ ${index}/${total}`,
  countdown: (seconds) => `${seconds} վրկ`,
  skipAction: 'Բաց թողնել  ›',
  skipCountdown: (seconds) => `Բաց թողնել ${seconds}`,
  learnMore: 'Իմանալ ավելին',
  unmute: 'Միացնել ձայնը',
  nowPlayingTitle: 'Գովազդ',
}

/**
 * The strings for a language tag — `hy`, `hy-AM` and the like get Armenian,
 * anything else English. With no tag, the page's own `<html lang>` decides.
 */
export function vastStringsFor(language?: string | null): VastStrings {
  const tag = language ?? (typeof document !== 'undefined' ? document.documentElement.lang : '') ?? ''
  return tag.toLowerCase().startsWith('hy') ? VAST_STRINGS_HY : VAST_STRINGS_EN
}
