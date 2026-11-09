import type { VastAd } from './VastAd.js'

/**
 * Decides play order for a VAST response (§3.3.1).
 *
 * Sequenced ads form the pod and play in numerical order. Non-sequenced ads are
 * the "ad buffet" and are held back as substitutes for pod members that fail.
 */
export class VastPodScheduler {
  private readonly pod: readonly VastAd[]
  private readonly spares: VastAd[]
  private index = 0

  constructor(ads: readonly VastAd[]) {
    const sequenced = stableSortBySequence(ads.filter((ad) => ad.sequence !== null))
    const standAlone = ads.filter((ad) => ad.sequence === null)
    // A response with no sequenced ads is a plain single/buffet response;
    // play the first stand-alone ad as the "pod".
    const first = standAlone[0]
    if (sequenced.length === 0 && first !== undefined) {
      this.pod = [first]
      this.spares = standAlone.slice(1)
    } else {
      this.pod = sequenced
      this.spares = standAlone
    }
  }

  get totalCount(): number {
    return this.pod.length
  }

  get currentIndex(): number {
    return this.index
  }

  /**
   * What {@link next} would hand over, without handing it over.
   *
   * For warming the creative after this one while this one plays. Consuming the
   * entry to look at it would mean playing the pod in the wrong order, so
   * looking has to be free.
   */
  peek(): VastAd | null {
    return this.pod[this.index] ?? null
  }

  next(): VastAd | null {
    const ad = this.pod[this.index]
    if (ad === undefined) return null
    this.index += 1
    return ad
  }

  /**
   * The ad just handed out could not play. Substitute an unplayed stand-alone
   * ad if one exists; otherwise the caller moves on to the next pod entry.
   */
  substituteForFailure(): VastAd | null {
    return this.spares.shift() ?? null
  }
}

/**
 * Ads sharing a `sequence` keep the response's order, as Kotlin's `sortedBy`
 * keeps it. `Array.prototype.sort` is only guaranteed stable from ES2019, and
 * the smart-TV Chromiums the ES2017 floor exists for predate that.
 */
function stableSortBySequence(ads: readonly VastAd[]): VastAd[] {
  return ads
    .map((ad, position) => ({ ad, position }))
    .sort((a, b) => (a.ad.sequence ?? 0) - (b.ad.sequence ?? 0) || a.position - b.position)
    .map((entry) => entry.ad)
}
