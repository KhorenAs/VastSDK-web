import type { VastAd, VastExtension, VastViewableImpression } from './VastAd.js'
import type { VastTrackingMap } from './VastTrackingEvent.js'
import type { VastVerification } from './VastVerification.js'

/** One parsed `<VAST>` response, before Wrapper flattening. */
export interface VastDocument {
  readonly version: string
  readonly entries: readonly VastDocumentEntry[]
  /** Root-level `<Error>`, used for the "no ad" response (§2.3.6.4). */
  readonly noAdError: string | null
}

export function isNoAd(document: VastDocument): boolean {
  return document.entries.length === 0
}

export interface VastDocumentEntry {
  readonly id: string
  readonly sequence: number | null
  readonly body: VastDocumentBody
}

export type VastDocumentBody =
  | { readonly type: 'inLine'; readonly ad: VastAd }
  /** `<Wrapper>` — carries its own trackers plus the next tag to fetch. */
  | { readonly type: 'wrapper'; readonly wrapper: VastWrapper }
  /**
   * An `<InLine>` whose only creatives are ones this SDK does not play —
   * `<NonLinearAds>`, `<CompanionAds>`. Kept rather than dropped so the
   * server hears 201 ("expecting different linearity") instead of being told
   * it returned nothing, and so its `<Error>` URIs still fire.
   */
  | { readonly type: 'unplayableCreative'; readonly errors: readonly string[] }

export interface VastWrapper {
  readonly tagUri: string
  readonly impressions: readonly string[]
  readonly errors: readonly string[]
  readonly trackingEvents: VastTrackingMap
  readonly clickTracking: readonly string[]
  readonly clickThrough: string | null
  readonly extensions: readonly VastExtension[]
  /**
   * Verification vendors are usually injected by an intermediary rather than
   * the advertiser, so a Wrapper carrying them is the common case.
   */
  readonly verifications: readonly VastVerification[]
  /**
   * A Wrapper may ask about viewability on its own account (§3.6), and an
   * intermediary that wanted to hear does not stop wanting because the
   * InLine wanted to as well.
   */
  readonly viewableImpression: VastViewableImpression | null
  /** Default `true` (§3.19). */
  readonly followAdditionalWrappers: boolean
  /** Default `false` (§3.19). */
  readonly allowMultipleAds: boolean
  readonly fallbackOnNoAd: boolean | null
}

export function createWrapper(init: Partial<VastWrapper> & Pick<VastWrapper, 'tagUri'>): VastWrapper {
  return {
    tagUri: init.tagUri,
    impressions: init.impressions ?? [],
    errors: init.errors ?? [],
    trackingEvents: init.trackingEvents ?? {},
    clickTracking: init.clickTracking ?? [],
    clickThrough: init.clickThrough ?? null,
    extensions: init.extensions ?? [],
    verifications: init.verifications ?? [],
    viewableImpression: init.viewableImpression ?? null,
    followAdditionalWrappers: init.followAdditionalWrappers ?? true,
    allowMultipleAds: init.allowMultipleAds ?? false,
    fallbackOnNoAd: init.fallbackOnNoAd ?? null,
  }
}
