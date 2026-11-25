import type { VastAd } from '@kinodaran/vast-core'

/**
 * The actions that would carry a viewer past an ad, as the Media Session API
 * names them. `skipad` is among them until the ad's skip control comes due.
 */
const LOCKED_ACTIONS = ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack', 'skipad'] as const

type Action = (typeof LOCKED_ACTIONS)[number] | 'play' | 'pause'

interface MediaSessionLike {
  metadata: unknown
  playbackState?: string
  setActionHandler(action: string, handler: ((details?: unknown) => void) | null): void
}

/**
 * What the browser's media controls show and allow during a break.
 *
 * Media keys, a Bluetooth headset, the lock screen on a phone and the OS media
 * hub all speak to the page through `navigator.mediaSession`. Left alone they
 * would name the film while an ad plays, and a "next" or "seek" from any of
 * them would reach the content — or nothing at all — instead of being refused.
 * So for the length of a break they describe the ad, play and pause reach the
 * ad (reported as §3.14.1 `pause`/`resume`, as the viewer's own choice), and
 * every action that could get past it is switched off.
 *
 * Switched off means no handler, not a handler that does nothing: Chrome draws
 * a button in its Picture-in-Picture window and its media hub for every action
 * with a handler, so a no-op `skipad` is a "Skip Ad" button that never skips,
 * shown on every ad. With no handler the browser falls back to its own
 * behaviour, which for a seek moves the ad element (refused by the player) or
 * the hidden content (put back when the break ends). Once the ad's skip control
 * comes due, `skipad` is given the real skip — in a PiP window it is the only
 * skip control the viewer can reach (§2.3).
 *
 * The metadata is saved and put back. Action handlers cannot be: the API has
 * no getter for them. The locked actions are reset to `null` when the break
 * starts and again when it ends — the browser's own behaviour — so a host that
 * registers its own handlers re-registers them when the break ends
 * (`allAdsFinished`), or chooses `mediaSession: 'untouched'` and keeps the
 * whole API to itself.
 */
export class VastMediaSessionLock {
  private savedMetadata: unknown = undefined
  private engaged = false

  constructor(
    private readonly title: string,
    private readonly mediaSession: MediaSessionLike | null = defaultMediaSession(),
  ) {}

  engage(ad: VastAd, handlers: { play: () => void; pause: () => void }): void {
    const session = this.mediaSession
    if (!session) return
    if (!this.engaged) {
      this.savedMetadata = session.metadata
      this.engaged = true
    }
    session.metadata = metadataFor(ad, this.title)
    this.set(session, 'play', handlers.play)
    this.set(session, 'pause', handlers.pause)
    for (const action of LOCKED_ACTIONS) this.set(session, action, null)
  }

  /**
   * The ad's skip control has come due: offer it through the media controls
   * too. Until the next {@link engage} or {@link release}.
   */
  allowSkip(skip: () => void): void {
    const session = this.mediaSession
    if (!session || !this.engaged) return
    this.set(session, 'skipad', skip)
  }

  /**
   * The ad that could be skipped has ended. Safari draws its PiP window in
   * ad mode — the "Ad" badge, the skip button — for as long as `skipad` has
   * a handler, so it goes with the ad rather than with the break.
   */
  withdrawSkip(): void {
    const session = this.mediaSession
    if (!session || !this.engaged) return
    this.set(session, 'skipad', null)
  }

  release(): void {
    const session = this.mediaSession
    if (!session || !this.engaged) return
    this.engaged = false
    session.metadata = this.savedMetadata ?? null
    this.savedMetadata = undefined
    for (const action of [...LOCKED_ACTIONS, 'play', 'pause'] as const) this.set(session, action, null)
  }

  private set(session: MediaSessionLike, action: Action, handler: (() => void) | null): void {
    try {
      session.setActionHandler(action, handler)
    } catch {
      // An action this browser does not know (`skipad`, `seekto` on older engines).
    }
  }
}

function metadataFor(ad: VastAd, fallbackTitle: string): unknown {
  const init = { title: ad.title?.trim() || fallbackTitle, artist: ad.advertiser ?? '', album: '' }
  const Metadata = (globalThis as { MediaMetadata?: new (init: object) => unknown }).MediaMetadata
  return Metadata ? new Metadata(init) : init
}

function defaultMediaSession(): MediaSessionLike | null {
  if (typeof navigator === 'undefined') return null
  const session = (navigator as Navigator & { mediaSession?: MediaSessionLike }).mediaSession
  return session ?? null
}
