import { describe, expect, it } from 'vitest'
import { createMediaFile, type VastDelivery, type VastMediaFile } from '../src/VastAd.js'
import { VastError, VastException } from '../src/VastError.js'
import { createMediaCapabilities, VastMediaFileSelector } from '../src/VastMediaFileSelector.js'

/**
 * Foundation's `URL.lastPathComponent`. A copy of the helper in `support.ts`,
 * which imports the parser this file has no other use for.
 */
function lastPathComponent(url: string): string {
  const path = url.split('#')[0]!.split('?')[0]!.replace(/\/+$/, '')
  return path.substring(path.lastIndexOf('/') + 1)
}

/**
 * Selection is a ranking rather than a filter wherever the spec allows it: an ad
 * with one poorly-fitting media file should still play.
 */
describe('VastMediaFileSelector', () => {
  const selector = new VastMediaFileSelector()
  const capabilities = createMediaCapabilities({ width: 1280, height: 720 })

  function file(
    url: string,
    {
      type = 'video/mp4',
      delivery = 'progressive',
      width = null,
      height = null,
    }: { type?: string; delivery?: VastDelivery; width?: number | null; height?: number | null } = {},
  ): VastMediaFile {
    return createMediaFile({ url, mimeType: type, delivery, width, height })
  }

  // MARK: - Transport security

  /** A response offering both renditions must not have the http one chosen and then refused as cleartext. */
  it('httpsIsPreferredOverAnOtherwiseIdenticalHttpFile', () => {
    const chosen = selector.select(
      [file('http://ads.test/a.mp4', { width: 854, height: 480 }), file('https://ads.test/a.mp4', { width: 854, height: 480 })],
      capabilities,
    )
    expect(chosen.url.startsWith('https:')).toBe(true)
  })

  /** The preference only decides between otherwise equal files. */
  it('theHttpsPreferenceDoesNotOverrideAMuchBetterFit', () => {
    const chosen = selector.select(
      [file('http://ads.test/fits.mp4', { width: 854, height: 480 }), file('https://ads.test/huge.mp4', { width: 3840, height: 2160 })],
      capabilities,
    )
    expect(lastPathComponent(chosen.url)).toBe('fits.mp4')
  })

  /** An http-only response still plays: refusing it would be the SDK deciding the advertiser loses the delivery. */
  it('anHttpOnlyResponseIsStillPlayed', () => {
    expect(lastPathComponent(selector.select([file('http://ads.test/only.mp4', { width: 854, height: 480 })], capabilities).url)).toBe(
      'only.mp4',
    )
  })

  // MARK: - Fit

  it('theClosestResolutionWins', () => {
    const chosen = selector.select(
      [
        file('https://ads.test/small.mp4', { width: 320, height: 180 }),
        file('https://ads.test/right.mp4', { width: 1280, height: 720 }),
        file('https://ads.test/huge.mp4', { width: 3840, height: 2160 }),
      ],
      capabilities,
    )
    expect(lastPathComponent(chosen.url)).toBe('right.mp4')
  })

  /** The penalty for undershooting rises twice as fast as the one for overshooting. */
  it('undershootingIsPenalisedMoreThanOvershooting', () => {
    const chosen = selector.select(
      [file('https://ads.test/under.mp4', { width: 960, height: 540 }), file('https://ads.test/over.mp4', { width: 1600, height: 900 })],
      capabilities,
    )
    expect(lastPathComponent(chosen.url)).toBe('over.mp4')
  })

  /** Half and double really are equal, so the response's own order decides. */
  it('equalDistanceLeavesTheResponseOrderToDecide', () => {
    const files = [file('https://ads.test/half.mp4', { width: 640, height: 360 }), file('https://ads.test/double.mp4', { width: 2560, height: 1440 })]

    expect(lastPathComponent(selector.select(files, capabilities).url)).toBe('half.mp4')
    expect(lastPathComponent(selector.select([...files].reverse(), capabilities).url)).toBe('double.mp4')
  })

  // MARK: - What is refused

  /** One file the player cannot decode must not lose the ad when another can. */
  it('anUndecodableContainerIsSkippedRatherThanChosen', () => {
    const chosen = selector.select(
      [file('https://ads.test/flash.flv', { type: 'video/x-flv', width: 1280, height: 720 }), file('https://ads.test/ok.mp4', { width: 320, height: 180 })],
      capabilities,
    )
    expect(lastPathComponent(chosen.url)).toBe('ok.mp4')
  })

  it('nothingPlayableIsReportedAs403', () => {
    let thrown: unknown = null
    try {
      selector.select([file('https://ads.test/x.flv', { type: 'video/x-flv' })], capabilities)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(VastException)
    const error = (thrown as VastException).error
    expect(error).toBe(VastError.NO_SUPPORTED_MEDIA_FILE)
    expect(error).toBe(403)
  })

  /** A player with no streaming pipeline cannot take a streaming delivery, however well it fits. */
  it('streamingIsRefusedWhereItCannotBePlayed', () => {
    const chosen = selector.select(
      [
        file('https://ads.test/live.m3u8', { type: 'application/x-mpegurl', delivery: 'streaming', width: 1280, height: 720 }),
        file('https://ads.test/file.mp4', { width: 320, height: 180 }),
      ],
      { ...capabilities, supportsStreaming: false },
    )
    expect(lastPathComponent(chosen.url)).toBe('file.mp4')
  })

  /** MIME types arrive in any case; matching them exactly would refuse playable files. */
  it('mimeTypeMatchingIgnoresCase', () => {
    expect(lastPathComponent(selector.select([file('https://ads.test/a.mp4', { type: 'Video/MP4' })], capabilities).url)).toBe('a.mp4')
  })
})
