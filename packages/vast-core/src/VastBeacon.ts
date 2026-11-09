import type { VastError } from './VastError.js'
import type { VastTrackingEvent } from './VastTrackingEvent.js'
import type { VastNotExecutedReason } from './VastVerification.js'

/**
 * A tracking request the engine decided should be sent.
 *
 * The engine returns these rather than performing IO, so tests assert on plain
 * values instead of mocking a network layer.
 */
export interface VastBeacon {
  readonly kind: VastBeaconKind
  readonly url: string
  readonly adId: string
}

export type VastBeaconKind =
  | { readonly type: 'impression' }
  | { readonly type: 'tracking'; readonly event: VastTrackingEvent }
  | { readonly type: 'progress'; readonly offset: number }
  | { readonly type: 'clickTracking' }
  | { readonly type: 'error'; readonly error: VastError }
  /**
   * A verification vendor asked to observe this ad and nothing ran its code
   * (§3.16). Silence would let the vendor count the session as measured, so
   * the reason is reported rather than withheld.
   */
  | { readonly type: 'verificationNotExecuted'; readonly reason: VastNotExecutedReason }
  /**
   * `<ViewUndetermined>` (§3.6): the response asked about viewability and
   * this player cannot measure it. The same reasoning as above — silence
   * would let a buyer treat an unmeasured impression as a measured one.
   */
  | { readonly type: 'viewUndetermined' }
  /**
   * `<CustomClick>` (§3.10.3): an interaction the host reported that opens
   * nothing, as distinct from a click-through.
   */
  | { readonly type: 'customClick' }
