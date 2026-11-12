export const DASH_MIME = 'application/dash+xml'
export const HLS_MIMES: readonly string[] = ['application/vnd.apple.mpegurl', 'application/x-mpegurl']
export type VastWebVideoFormat = 'hls' | 'dash' | 'mp4'

export function supportsDashPlayback(): boolean {
  return typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401e"')
}

export function preferredWebVideoFormat(
  userAgent: string | null,
  canPlayType: (mimeType: string) => boolean,
  supportsDash: boolean,
): VastWebVideoFormat | null {
  const safari = /\bVersion\/[\d.]+.*\bSafari\//.test(userAgent ?? '') &&
    !/\b(?:Chrome|Chromium|CriOS|Firefox|FxiOS|Edg|EdgiOS|OPR|OPiOS)\//.test(userAgent ?? '')
  if (safari) return HLS_MIMES.some(canPlayType) ? 'hls' : null
  return supportsDash ? 'dash' : null
}

/** Formats to put in the ad request's video_formats field. */
export function webVideoFormats(): VastWebVideoFormat[] {
  if (typeof document === 'undefined') return ['mp4']
  const video = document.createElement('video')
  const preferred = preferredWebVideoFormat(
    document.defaultView?.navigator.userAgent ?? null,
    (mimeType) => video.canPlayType(mimeType) !== '',
    supportsDashPlayback(),
  )
  return preferred ? [preferred, 'mp4'] : ['mp4']
}
