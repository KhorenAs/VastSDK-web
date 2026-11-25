import { afterEach, describe, expect, it, vi } from 'vitest'
import { VastAdOverlay, setSourceQuietly } from '@kinodaran/vast-kit'
import {
  createVastVideojs,
  registerVastPlugin,
  VAST_BREAK_CLASS,
  videojsContent,
  type VastVideojs,
  type VideoJsLike,
  type VideoJsPlayerLike,
} from '../src/VastVideojs.js'
import { MapLoader, RecordingTransport, ScriptedClock, ScriptedMedia, TAG, inLine } from '../../vast-kit/test/harness.js'

/**
 * A Video.js player as the adapter sees it: the dozen methods it calls, with
 * Video.js's own semantics — `play` and `pause` fire their events, `currentTime`
 * reads without an argument and seeks with one.
 */
class FakePlayer implements VideoJsPlayerLike {
  readonly element = document.createElement('div')
  readonly tech = document.createElement('video')
  isPaused = true
  isEnded = false
  time = 0
  hasControls = true
  level = 0.6
  isMuted = false
  wantsAutoplay = false
  readonly classes = new Set<string>()
  readonly calls: string[] = []
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>()

  constructor() {
    this.element.appendChild(this.tech)
    document.body.appendChild(this.element)
  }

  el(): Element {
    return this.element
  }
  play(): Promise<void> {
    this.calls.push('play')
    if (this.isPaused) {
      this.isPaused = false
      this.trigger('play')
    }
    return Promise.resolve()
  }
  pause(): void {
    this.calls.push('pause')
    if (!this.isPaused) {
      this.isPaused = true
      this.trigger('pause')
    }
  }
  paused(): boolean {
    return this.isPaused
  }
  ended(): boolean {
    return this.isEnded
  }
  currentTime(): number
  currentTime(seconds: number): unknown
  currentTime(seconds?: number): unknown {
    if (seconds === undefined) return this.time
    this.calls.push(`seek ${seconds}`)
    this.time = seconds
    return undefined
  }
  volume(): number {
    return this.level
  }
  muted(): boolean {
    return this.isMuted
  }
  controls(): boolean
  controls(enabled: boolean): unknown
  controls(enabled?: boolean): unknown {
    if (enabled === undefined) return this.hasControls
    this.hasControls = enabled
    return undefined
  }
  addClass(name: string): void {
    this.classes.add(name)
  }
  removeClass(name: string): void {
    this.classes.delete(name)
  }
  autoplay(): unknown {
    return this.wantsAutoplay
  }
  on(event: string, handler: (...args: unknown[]) => void): void {
    let set = this.handlers.get(event)
    if (!set) this.handlers.set(event, (set = new Set()))
    set.add(handler)
  }
  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler)
  }
  trigger(event: string): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler()
  }
  listeners(event: string): number {
    return this.handlers.get(event)?.size ?? 0
  }
}

const players: FakePlayer[] = []
const integrations: VastVideojs[] = []

function fakePlayer(): FakePlayer {
  const player = new FakePlayer()
  players.push(player)
  return player
}

afterEach(() => {
  for (const vast of integrations.splice(0)) vast.destroy()
  for (const player of players.splice(0)) player.element.remove()
  vi.restoreAllMocks()
})

// MARK: - The content player

describe('videojsContent', () => {
  it.each(['picture-in-picture', 'fullscreen'])('handles Safari native %s before a break', (mode) => {
    const player = fakePlayer()
    const exitFullscreen = vi.fn()
    Object.assign(player.tech, {
      webkitDisplayingFullscreen: true,
      webkitPresentationMode: mode,
      webkitExitFullscreen: exitFullscreen,
    })

    videojsContent(player).pauseForBreak()

    expect(exitFullscreen).toHaveBeenCalledTimes(mode === 'fullscreen' ? 1 : 0)
  })

  describe('lending the film element to a mid-roll in PiP', () => {
    const FILM = 'https://cdn.test/film/master.m3u8'

    /** A film in Safari's native HLS, in a PiP window, with Video.js's own `src` wrapper on the element. */
    function filmInPictureInPicture(options: { webkit?: boolean } = {}) {
      const player = fakePlayer()
      const video = player.tech
      const media = new ScriptedMedia(video)
      const sourcesets: string[] = []
      const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!
      Object.defineProperty(video, 'src', {
        configurable: true,
        get: () => native.get!.call(video),
        set: (url: string) => {
          native.set!.call(video, url)
          sourcesets.push(url)
        },
      })
      video.src = FILM
      sourcesets.length = 0
      if (options.webkit !== false) Object.assign(video, { webkitSetPresentationMode: vi.fn() })
      Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: video })
      return { player, video, media, sourcesets }
    }

    afterEach(() => { Reflect.deleteProperty(document, 'pictureInPictureElement') })

    it('lends it in Safari by default, and nowhere else unless asked', () => {
      const safari = filmInPictureInPicture()
      expect(videojsContent(safari.player).borrowVideoForPiP?.()?.video).toBe(safari.video)
      expect(videojsContent(safari.player, { sameElementPiP: false }).borrowVideoForPiP?.()).toBeNull()

      const chrome = filmInPictureInPicture({ webkit: false })
      expect(videojsContent(chrome.player).borrowVideoForPiP?.(), 'Chrome moves the window itself').toBeNull()
      expect(videojsContent(chrome.player, { sameElementPiP: true }).borrowVideoForPiP?.()?.video).toBe(chrome.video)
    })

    it('lends only a film the element plays from a URL, and DRM only when asked', () => {
      const { player } = filmInPictureInPicture()
      const content = videojsContent(player)
      expect(content.borrowVideoForPiP?.()).not.toBeNull()
      expect(content.borrowVideoForPiP?.(), 'one break at a time').toBeNull()

      const mse = filmInPictureInPicture()
      Object.defineProperty(mse.video, 'currentSrc', { configurable: true, value: 'blob:https://www.example.com/1' })
      expect(videojsContent(mse.player).borrowVideoForPiP?.(), 'a MediaSource cannot be given back').toBeNull()

      const drm = filmInPictureInPicture()
      Object.defineProperty(drm.video, 'mediaKeys', { configurable: true, value: {} })
      expect(videojsContent(drm.player).borrowVideoForPiP?.()).toBeNull()
      expect(videojsContent(drm.player, { sameElementPiPForProtectedContent: true }).borrowVideoForPiP?.()?.video).toBe(drm.video)

      Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: null })
      Reflect.deleteProperty(player.tech, 'webkitSetPresentationMode')
      expect(videojsContent(player).borrowVideoForPiP?.(), 'nothing to lend for when the film is not in PiP').toBeNull()
    })

    it('puts the film back where it was without Video.js seeing a change of source', async () => {
      const { player, video, media, sourcesets } = filmInPictureInPicture()
      video.loop = true
      video.muted = true
      media.currentTime = 42
      player.time = 42
      const content = videojsContent(player)
      content.pauseForBreak()
      const borrowed = content.borrowVideoForPiP?.()
      expect(borrowed?.video).toBe(video)
      expect(video.loop).toBe(false)

      // The ad, as the session's player sets it on a lent element.
      setSourceQuietly(video, 'https://cdn.test/ad.mp4')
      media.currentTime = 9
      video.muted = false
      media.readyState = 1
      await borrowed!.restore()

      expect(video.currentSrc).toBe(FILM)
      expect(sourcesets, "Video.js's source never changed").toEqual([])
      expect(video.currentTime).toBe(42)
      expect(video.loop).toBe(true)
      expect(video.muted).toBe(true)
      expect(content.borrowVideoForPiP?.(), 'lendable again after the break').not.toBeNull()
    })
  })

  it('pauses the film, takes the controls away and marks the player for the break', () => {
    const player = fakePlayer()
    player.isPaused = false
    const content = videojsContent(player)

    content.pauseForBreak()

    expect(player.isPaused).toBe(true)
    expect(player.hasControls, 'an ad the viewer can scrub is an ad the viewer can get past').toBe(false)
    expect(player.classes.has(VAST_BREAK_CLASS)).toBe(true)
  })

  it('undoes a play on the film during the break — a hotkey, or the host’s own code', () => {
    const player = fakePlayer()
    const content = videojsContent(player)
    content.pauseForBreak()

    player.play()

    expect(player.isPaused, 'the film does not play behind an ad').toBe(true)
  })

  it('gives everything back after the break and plays on from where the viewer was', () => {
    const player = fakePlayer()
    player.isPaused = false
    player.time = 42
    const content = videojsContent(player)
    content.pauseForBreak()

    content.resumeAfterBreak()

    expect(player.hasControls).toBe(true)
    expect(player.classes.has(VAST_BREAK_CLASS)).toBe(false)
    expect(player.isPaused).toBe(false)
    expect(player.time).toBe(42)
    expect(player.calls, 'no seek when the film did not move').not.toContain('seek 42')
  })

  it('puts the film back where it was when something seeked it behind the ad', () => {
    const player = fakePlayer()
    player.isPaused = false
    player.time = 42
    const content = videojsContent(player)
    content.pauseForBreak()

    player.currentTime(120)
    content.resumeAfterBreak()

    expect(player.time, 'a seek on the hidden film is not the viewer’s to keep').toBe(42)
  })

  it('restores controls from what it saved, not from a default', () => {
    const player = fakePlayer()
    player.hasControls = false
    const content = videojsContent(player)

    content.pauseForBreak()
    content.resumeAfterBreak()

    expect(player.hasControls).toBe(false)
  })

  it('leaves a film that was paused paused', () => {
    const player = fakePlayer()
    const content = videojsContent(player)

    content.pauseForBreak()
    content.resumeAfterBreak()

    expect(player.isPaused).toBe(true)
    expect(player.calls).not.toContain('play')
  })

  it('counts a pre-roll asked for before the film really started as playing', () => {
    const player = fakePlayer()
    player.wantsAutoplay = true
    const content = videojsContent(player)

    content.pauseForBreak()
    content.resumeAfterBreak()

    expect(player.isPaused).toBe(false)
  })

  it('does not restart a film that ended — the post-roll case', () => {
    const player = fakePlayer()
    player.isPaused = false
    const content = videojsContent(player)
    content.pauseForBreak()
    player.isEnded = true

    content.resumeAfterBreak()

    expect(player.calls).not.toContain('play')
    expect(player.calls.filter((call) => call.startsWith('seek'))).toEqual([])
  })

  it('stops holding the film once the break is over', () => {
    const player = fakePlayer()
    const content = videojsContent(player)
    content.pauseForBreak()
    content.resumeAfterBreak()

    player.play()

    expect(player.isPaused).toBe(false)
    expect(player.listeners('play')).toBe(0)
  })

  it('is safe to call twice either way', () => {
    const player = fakePlayer()
    player.isPaused = false
    player.time = 10
    const content = videojsContent(player)

    content.pauseForBreak()
    player.time = 11
    content.pauseForBreak()
    content.resumeAfterBreak()
    content.resumeAfterBreak()

    expect(player.time, 'the second pause did not overwrite what was saved').toBe(10)
    expect(player.calls.filter((call) => call === 'play')).toHaveLength(1)
  })

  it('leaves iPhone native fullscreen first, which nothing can be drawn over', () => {
    const player = fakePlayer()
    const exit = vi.fn()
    Object.assign(player.tech, { webkitDisplayingFullscreen: true, webkitExitFullscreen: exit })

    videojsContent(player).pauseForBreak()

    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('reports the film’s volume, mute and position for the ad and the macros', () => {
    const player = fakePlayer()
    player.level = 0.3
    player.isMuted = true
    player.time = 12.5
    const content = videojsContent(player)

    expect([content.volume, content.muted, content.currentTime]).toEqual([0.3, true, 12.5])
  })
})

// MARK: - Wiring

describe('createVastVideojs', () => {
  it('draws the break over the player element, with the SDK overlay by default', () => {
    const player = fakePlayer()
    const vast = createVastVideojs(player)
    integrations.push(vast)

    expect(player.element.contains(vast.session.adPlayer.layer)).toBe(true)
    expect(vast.overlay).toBeInstanceOf(VastAdOverlay)
  })

  it('draws no overlay for a host with its own ad UI', () => {
    const vast = createVastVideojs(fakePlayer(), { overlay: false })
    integrations.push(vast)

    expect(vast.overlay).toBeNull()
  })

  it('prepares the ad element on every gesture on the player, as IMA asks a host to by hand', () => {
    const player = fakePlayer()
    const vast = createVastVideojs(player)
    integrations.push(vast)
    const prepare = vi.spyOn(vast.session, 'prepare')

    for (const type of ['click', 'touchend', 'keydown']) player.tech.dispatchEvent(new Event(type, { bubbles: true }))

    expect(prepare).toHaveBeenCalledTimes(3)
  })

  it('tears itself down with the player', () => {
    const player = fakePlayer()
    const vast = createVastVideojs(player)
    const prepare = vi.spyOn(vast.session, 'prepare')
    const layer = vast.session.adPlayer.layer

    player.trigger('dispose')
    player.tech.dispatchEvent(new Event('click', { bubbles: true }))

    expect(player.element.contains(layer)).toBe(false)
    expect(prepare).not.toHaveBeenCalled()
    expect(player.listeners('dispose')).toBe(0)
  })

  it('plays a pre-roll on the first play and gives the film back after it', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe')
    const player = fakePlayer()
    const clock = new ScriptedClock()
    const transport = new RecordingTransport()
    const vast = createVastVideojs(player, {
      configuration: { clock, transport, loader: new MapLoader({ [TAG]: inLine('a1') }), mediaLoadTimeoutSeconds: 0 },
    })
    integrations.push(vast)
    const media = new ScriptedMedia(vast.session.adPlayer.video)
    const settle = async () => {
      for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve))
    }

    // Once: the film's own `play` after the break must not ask for another pre-roll.
    let prerollAsked = false
    player.on('play', () => {
      if (prerollAsked) return
      prerollAsked = true
      void vast.session.playBreak(TAG, { position: 'preroll' })
    })
    player.play()
    await settle()

    expect(vast.session.getSnapshot().state.type).toBe('playing')
    expect(player.isPaused).toBe(true)
    expect(player.hasControls).toBe(false)

    for (let t = 0; t <= 10; t++) clock.push({ adTime: t, duration: 10, rate: 1, wallClock: 100 + t })
    media.reachEnd()
    await settle()

    expect(vast.session.getSnapshot().state).toEqual({ type: 'finished', outcome: { type: 'completed' } })
    expect(player.hasControls).toBe(true)
    expect(player.isPaused).toBe(false)
    expect(transport.urls).toContain('https://ads.test/a1/complete')
  })
})

describe('registerVastPlugin', () => {
  it('registers player.vast(), which wires the player it is called on', () => {
    let registered: { name: string; plugin: (this: VideoJsPlayerLike, options?: object) => VastVideojs } | null = null
    const videojs: VideoJsLike = {
      registerPlugin: (name, plugin) => {
        registered = { name, plugin }
      },
    }
    registerVastPlugin(videojs)
    const player = fakePlayer()

    const vast = registered!.plugin.call(player, { overlay: false })
    integrations.push(vast)

    expect(registered!.name).toBe('vast')
    expect(player.element.contains(vast.session.adPlayer.layer)).toBe(true)
    expect(vast.overlay).toBeNull()
  })
})
