import type { VastAd, VastError, VastTrackingEvent, VastVerification } from '@kinodaran/vast-core'

/**
 * Where third-party measurement plugs in.
 *
 * The SDK parses `<AdVerifications>` and never executes it: running a vendor's
 * code means the IAB Open Measurement SDK for Web, which is licensed
 * separately, ships as its own script, and runs vendor JavaScript in iframes of
 * its own. None of that belongs in this library — so this interface is the
 * seam, and an implementation lives outside.
 *
 * Supplying one changes what the SDK reports. With no measurement configured,
 * every vendor is told `verificationNotExecuted`, because that is the truth. With
 * one configured the SDK goes quiet and the implementation owns the reporting,
 * including telling the session when a resource failed to load —
 * `RESOURCE_LOAD_ERROR` can only be known by whoever tried.
 */
export interface VastMeasurement {
  /** One ad is about to be shown. Called before the impression. */
  begin(context: VastMeasurementContext): void

  /** Playback reached something a measurement vendor cares about. */
  record(event: VastMeasurementEvent): void

  /** The ad is over, by any route. Called exactly once per `begin`. */
  finish(): void

  /**
   * The OMID partner name and version, as the vendor's script sees it, for the
   * `[OMIDPARTNER]` macro. `null` reports it as unknown — honest for an
   * integration that is not OMID.
   */
  readonly omidPartner?: string | null
}

/** What an implementation needs to open a measurement session. */
export interface VastMeasurementContext {
  readonly ad: VastAd
  readonly verifications: readonly VastVerification[]
  /** The element the creative plays in — what OM SDK for Web calls the video element. */
  readonly videoElement: HTMLVideoElement
  /** The element the ad's UI is drawn over, for viewability geometry. */
  readonly slotElement: HTMLElement
}

/**
 * Modelled as one union rather than a method per event so that the *sequence*
 * can be asserted in a test. Measurement integrations fail on order far more
 * often than on any single call.
 */
export type VastMeasurementEvent =
  | { readonly type: 'impression' }
  | { readonly type: 'start'; readonly duration: number; readonly isMuted: boolean }
  /** `firstQuartile`, `midpoint`, `thirdQuartile` or `complete`. */
  | { readonly type: 'quartile'; readonly event: VastTrackingEvent }
  | { readonly type: 'progress'; readonly offset: number }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'skipped' }
  | { readonly type: 'clicked' }
  | { readonly type: 'failed'; readonly error: VastError }
