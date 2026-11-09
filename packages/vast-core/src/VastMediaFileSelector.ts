import type { VastMediaFile } from './VastAd.js'
import { VastError, VastException } from './VastError.js'

/**
 * What the player can take, as {@link VastMediaFileSelector.select} weighs it.
 * Build one with {@link createMediaCapabilities}, which supplies the defaults.
 */
export interface VastMediaCapabilities {
  /** The ad surface's size in pixels — not the screen's: an inline player wants an inline rendition. */
  readonly width: number
  readonly height: number
  /**
   * Container types the player can decode, lower-case. Files outside this set
   * are rejected outright — playing them would produce error 403 anyway.
   */
  readonly supportedMimeTypes: ReadonlySet<string>
  /** Soft ceiling in kbps. Higher-bitrate files rank lower but stay eligible. */
  readonly preferredBitrate: number | null
  /** `false` where the player has no HLS pipeline — neither native HLS nor MSE with hls.js. */
  readonly supportsStreaming: boolean
}

/**
 * What a `<video>` element plays given an HLS pipeline: native in Safari, MSE
 * with hls.js elsewhere. The same set the Android SDK defaults to, so the SDKs
 * choose alike from the same response; a host that knows its browser better
 * passes what `canPlayType` says instead.
 *
 * QuickTime is left out although the Apple SDK lists it: browsers read some
 * `.mov` files and not others, and a creative that is chosen and then fails
 * costs a 405 where refusing it would have let an `.mp4` alternative play.
 */
export const WEB_DEFAULT_MIME_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/x-m4v',
  'video/3gpp',
  'video/webm',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
])

export type VastMediaCapabilitiesInit = Partial<VastMediaCapabilities> &
  Pick<VastMediaCapabilities, 'width' | 'height'>

export function createMediaCapabilities(init: VastMediaCapabilitiesInit): VastMediaCapabilities {
  return {
    width: init.width,
    height: init.height,
    supportedMimeTypes: init.supportedMimeTypes ?? WEB_DEFAULT_MIME_TYPES,
    preferredBitrate: init.preferredBitrate ?? null,
    supportsStreaming: init.supportsStreaming ?? true,
  }
}

/**
 * Picks the `<MediaFile>` best suited to the current device.
 *
 * Selection is a ranking rather than a filter wherever the spec allows it: an ad
 * with only one media file should still play even if its resolution or bitrate
 * is a poor fit, because a no-fill costs the advertiser a delivery while a
 * slightly-too-large file costs a little bandwidth.
 */
export class VastMediaFileSelector {
  /** @throws {VastException} with {@link VastError.NO_SUPPORTED_MEDIA_FILE} (403) when nothing is playable. */
  select(files: readonly VastMediaFile[], capabilities: VastMediaCapabilities): VastMediaFile {
    let best: VastMediaFile | null = null
    let bestCost = Infinity
    for (const file of files) {
      if (!playable(file, capabilities)) continue
      const fileCost = cost(file, capabilities)
      // The first of equal costs wins, so the response's own order decides a tie.
      if (best === null || fileCost < bestCost) {
        best = file
        bestCost = fileCost
      }
    }
    if (best === null) throw new VastException(VastError.NO_SUPPORTED_MEDIA_FILE)
    return best
  }
}

function playable(file: VastMediaFile, capabilities: VastMediaCapabilities): boolean {
  if (!capabilities.supportedMimeTypes.has(file.mimeType.toLowerCase())) return false
  if (file.delivery === 'streaming' && !capabilities.supportsStreaming) return false
  return true
}

/**
 * Lower is better. Resolution dominates because upscaling a small creative is
 * the most visible defect; bitrate breaks ties.
 */
function cost(file: VastMediaFile, capabilities: VastMediaCapabilities): number {
  let score = 0

  const width = file.width !== null && file.width > 0 ? file.width : null
  const height = file.height !== null && file.height > 0 ? file.height : null
  if (width !== null && height !== null) {
    const widthRatio = width / Math.max(capabilities.width, 1)
    const heightRatio = height / Math.max(capabilities.height, 1)
    const ratio = Math.max(widthRatio, heightRatio)
    // Being too small is penalised roughly twice as hard as being too large,
    // since the player can downscale cleanly but not invent detail.
    score += ratio >= 1 ? ratio - 1 : (1 - ratio) * 2
  } else {
    // Undeclared dimensions are common and are not disqualifying, but a file
    // that states its size is a safer pick when one exists.
    score += UNDECLARED_SIZE_COST
  }

  // A page served over https will not load http media: browsers block mixed
  // content, or upgrade the request and fail it when no https copy answers. A
  // response offering both renditions would otherwise have the http one chosen
  // and then fail as a media error. Small, so it only decides between otherwise
  // equal files.
  if (file.url.substring(0, 6).toLowerCase() !== 'https:') score += CLEARTEXT_COST

  const ceiling = capabilities.preferredBitrate
  const bitrate = effectiveBitrate(file)
  if (ceiling !== null && bitrate !== null) {
    const ratio = bitrate / Math.max(ceiling, 1)
    score += ratio > 1 ? ratio - 1 : 0
  }
  return score
}

/** VAST 4 lets a file declare a range instead of a single bitrate. */
function effectiveBitrate(file: VastMediaFile): number | null {
  if (file.bitrate !== null) return file.bitrate
  const minimum = file.minBitrate
  const maximum = file.maxBitrate
  if (minimum === null || maximum === null) return minimum ?? maximum
  // Whole kbps, as the other SDKs' integer division gives it.
  return Math.trunc((minimum + maximum) / 2)
}

/** What a file that does not state its size gives up to one that does. */
const UNDECLARED_SIZE_COST = 0.5

/** What an `http` rendition gives up to an `https` one: enough to decide a tie, no more. */
const CLEARTEXT_COST = 0.25
