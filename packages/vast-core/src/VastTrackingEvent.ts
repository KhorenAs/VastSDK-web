/**
 * Every event name VAST 4.3 §3.14.1 allows under `<TrackingEvents>`, spelled
 * exactly as the spec spells it.
 *
 * `progress` is intentionally absent: it carries an `offset` attribute and is
 * modelled by {@link VastProgressEvent} instead.
 */
export type VastTrackingEvent =
  // Player operation metrics
  | 'mute'
  | 'unmute'
  | 'pause'
  | 'resume'
  | 'rewind'
  | 'skip'
  | 'playerExpand'
  | 'playerCollapse'
  | 'notUsed'
  // VAST 2.0/3.0 names. Live ad servers still emit these — a real AdFox tag
  // sends `fullscreen`, `expand`, `collapse`, `acceptInvitation` and `close` —
  // so dropping them would silently lose tracking the server is waiting for.
  // They are kept distinct from their 4.x replacements rather than rewritten,
  // because the URIs behind them are the server's, not ours.
  | 'fullscreen'
  | 'exitFullscreen'
  | 'expand'
  | 'collapse'
  | 'acceptInvitation'
  | 'close'
  // Linear ad metrics
  | 'loaded'
  | 'start'
  | 'firstQuartile'
  | 'midpoint'
  | 'thirdQuartile'
  | 'complete'
  | 'otherAdInteraction'
  | 'closeLinear'
  | 'creativeView'

const ALL: readonly VastTrackingEvent[] = [
  'mute',
  'unmute',
  'pause',
  'resume',
  'rewind',
  'skip',
  'playerExpand',
  'playerCollapse',
  'notUsed',
  'fullscreen',
  'exitFullscreen',
  'expand',
  'collapse',
  'acceptInvitation',
  'close',
  'loaded',
  'start',
  'firstQuartile',
  'midpoint',
  'thirdQuartile',
  'complete',
  'otherAdInteraction',
  'closeLinear',
  'creativeView',
]

const NAMES = new Set<string>(ALL)

const REPEATABLE = new Set<VastTrackingEvent>([
  'mute',
  'unmute',
  'pause',
  'resume',
  'rewind',
  'otherAdInteraction',
  'fullscreen',
  'exitFullscreen',
  'expand',
  'collapse',
  'acceptInvitation',
])

const DERIVED = new Set<VastTrackingEvent>([
  'start',
  'firstQuartile',
  'midpoint',
  'thirdQuartile',
  'complete',
  'creativeView',
  'skip',
  'loaded',
])

const EXPAND_GROUP: readonly VastTrackingEvent[] = ['playerExpand', 'fullscreen', 'expand']
const COLLAPSE_GROUP: readonly VastTrackingEvent[] = ['playerCollapse', 'exitFullscreen', 'collapse']
const CLOSE_GROUP: readonly VastTrackingEvent[] = ['closeLinear', 'close']

export const VastTrackingEvent = {
  /** Every event, in the order §3.14.1 lists them. */
  all: ALL,

  /** The event a `<Tracking event="...">` names, matched exactly as the spec spells it. */
  fromVastName(name: string): VastTrackingEvent | null {
    return NAMES.has(name) ? (name as VastTrackingEvent) : null
  },

  /**
   * Quartiles require continuous playback at normal speed (§3.14.1), so a
   * forward seek past one of these must NOT fire it.
   */
  requiresContinuousPlayback(event: VastTrackingEvent): boolean {
    return event === 'firstQuartile' || event === 'midpoint' || event === 'thirdQuartile' || event === 'complete'
  },

  /** Events that may be sent at most once per ad. */
  isOnce(event: VastTrackingEvent): boolean {
    return !REPEATABLE.has(event)
  },

  /**
   * Whether a host may report this event directly.
   *
   * Quartiles, `start` and `complete` are derived from observed playback
   * instead, so that a caller cannot fabricate a billable event.
   */
  isHostReportable(event: VastTrackingEvent): boolean {
    return !DERIVED.has(event)
  },

  /**
   * Names that mean the same thing across VAST versions.
   *
   * VAST 4.3 §3.14.1 states that `playerExpand` replaces `fullscreen` and
   * `playerCollapse` replaces `exitFullscreen`, but servers keep sending the
   * old spelling. Firing one fires every equivalent, so a host reports the
   * event once and whichever name the server used is honoured.
   */
  equivalents(event: VastTrackingEvent): readonly VastTrackingEvent[] {
    if (EXPAND_GROUP.includes(event)) return EXPAND_GROUP
    if (COLLAPSE_GROUP.includes(event)) return COLLAPSE_GROUP
    if (CLOSE_GROUP.includes(event)) return CLOSE_GROUP
    return [event]
  },
} as const

/** Tracking URIs per event, in document order. */
export type VastTrackingMap = Readonly<Partial<Record<VastTrackingEvent, readonly string[]>>>
