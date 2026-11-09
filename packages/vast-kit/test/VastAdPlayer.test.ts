import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAd, createLinear, VastError, type VastTick } from '@kinodaran/vast-core'
import { errorFor, VastAdPlayer, type VastAdPlayerListener } from '../src/VastAdPlayer.js'
import { htmlVideoContent } from '../src/VastContentPlayer.js'
import { VastMediaSessionLock } from '../src/VastMediaSessionLock.js'
import { VAST_STRINGS_EN, VAST_STRINGS_HY, vastStringsFor } from '../src/VastStrings.js'
import { VastVideoClock } from '../src/VastVideoClock.js'
import { FakeMediaSession, MEDIA_ERR, ScriptedMedia, useFakeTimers } from './harness.js'

const A = 'https://cdn.test/a.mp4'
const B = 'https://cdn.test/b.mp4'

const containers: HTMLElement[] = []

function container(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.appendChild(element)
  containers.push(element)
  return element
}

function player(host: HTMLElement = container()) {
  const adPlayer = new VastAdPlayer(host)
  const media = new ScriptedMedia(adPlayer.video)
  const heard: string[] = []
  const listener: VastAdPlayerListener = {
    loaded: () => heard.push('loaded'),
    started: () => heard.push('started'),
    playbackChanged: (wants) => heard.push(wants ? 'wants playback' : 'stopped'),
    ended: () => heard.push('ended'),
    failed: (error) => heard.push(`failed ${error}`),
  }
  return { adPlayer, media, heard, listener }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve().then(() => new Promise<void>((resolve) => setImmediate(resolve)))
}

afterEach(() => {
  for (const element of containers.splice(0)) element.remove()
  vi.useRealTimers()
})

// MARK: - The element

describe('VastAdPlayer', () => {
  it.each([
    [MEDIA_ERR.NETWORK, VastError.MEDIA_FILE_NOT_FOUND],
    [MEDIA_ERR.SRC_NOT_SUPPORTED, VastError.MEDIA_FILE_NOT_FOUND],
    [MEDIA_ERR.DECODE, VastError.MEDIA_FILE_DISPLAY_PROBLEM],
    [MEDIA_ERR.ABORTED, VastError.MEDIA_FILE_DISPLAY_PROBLEM],
  ])('maps MediaError %i to VAST %i', (code, error) => {
    expect(errorFor({ code } as MediaError)).toBe(error)
  })

  it('maps a missing MediaError to 405', () => {
    expect(errorFor(null)).toBe(VastError.MEDIA_FILE_DISPLAY_PROBLEM)
  })

  it('builds an element with no way around the ad: no controls, no Picture in Picture, no casting', () => {
    const host = container()
    const { adPlayer } = player(host)
    const video = adPlayer.video

    expect(video.controls).toBe(false)
    expect(video.playsInline).toBe(true)
    expect(video.preload).toBe('auto')
    for (const attribute of ['playsinline', 'webkit-playsinline', 'disablepictureinpicture', 'disableremoteplayback']) {
      expect(video.hasAttribute(attribute), attribute).toBe(true)
    }
    expect(video.getAttribute('x-webkit-airplay')).toBe('deny')
    expect(adPlayer.layer.contains(video)).toBe(true)
    expect(host.contains(adPlayer.layer)).toBe(true)
    expect(adPlayer.layer.style.display, 'shown only while a break is on screen').toBe('none')
  })

  it('positions a static container so the layer covers the player, not the page', () => {
    const host = container()
    player(host)
    expect(host.style.position).toBe('relative')

    const positioned = container()
    positioned.style.position = 'absolute'
    player(positioned)
    expect(positioned.style.position).toBe('absolute')
  })

  describe('starting', () => {
    it('reports started when the browser lets it play with sound', async () => {
      const { adPlayer, media, listener } = player()
      expect(await adPlayer.load(A, listener, { volume: 1, muted: false })).toBe('started')
      expect(media.calls).toEqual(['load', 'play'])
      expect(adPlayer.video.muted).toBe(false)
    })

    it('falls back to a muted start when the browser refuses sound', async () => {
      const { adPlayer, media, listener } = player()
      media.autoplay = 'mutedOnly'
      expect(await adPlayer.load(A, listener, { volume: 1, muted: false })).toBe('mutedByPolicy')
      expect(media.calls).toEqual(['load', 'play:refused', 'play'])
      expect(adPlayer.video.muted).toBe(true)
    })

    it('reports refused when the browser refuses even a muted start', async () => {
      const { adPlayer, media, listener } = player()
      media.autoplay = 'refused'
      expect(await adPlayer.load(A, listener, { volume: 1, muted: false })).toBe('refused')
      expect(media.calls).toEqual(['load', 'play:refused', 'play:refused'])
    })

    it('does not try a second time when it was already muted', async () => {
      const { adPlayer, media, listener } = player()
      media.autoplay = 'refused'
      expect(await adPlayer.load(A, listener, { volume: 1, muted: true })).toBe('refused')
      expect(media.calls).toEqual(['load', 'play:refused'])
    })

    it('reports interrupted for a failure that is no policy refusal, leaving it to the error event', async () => {
      const { adPlayer, media, heard, listener } = player()
      media.failures.set(A, MEDIA_ERR.SRC_NOT_SUPPORTED)
      expect(await adPlayer.load(A, listener, { volume: 1, muted: false })).toBe('interrupted')
      expect(heard).toEqual(['wants playback', `failed ${VastError.MEDIA_FILE_NOT_FOUND}`])
    })

    it('reports interrupted when a later creative replaced it mid-start', async () => {
      const { adPlayer, media, listener } = player()
      media.autoStart = false
      const first = adPlayer.load(A, listener, { volume: 1, muted: false })
      media.autoStart = true
      const second = adPlayer.load(B, listener, { volume: 1, muted: false })

      expect(await first).toBe('interrupted')
      expect(await second).toBe('started')
    })

    it('starts as loud as asked, within what an element accepts', async () => {
      const { adPlayer, listener } = player()
      await adPlayer.load(A, listener, { volume: 0.3, muted: true })
      expect([adPlayer.video.volume, adPlayer.video.muted]).toEqual([0.3, true])
      await adPlayer.load(B, listener, { volume: 1.5, muted: false })
      expect(adPlayer.video.volume).toBe(1)
      await adPlayer.load(A, listener, { volume: -1, muted: false })
      expect(adPlayer.video.volume).toBe(0)
      await adPlayer.load(B, listener, { volume: Number.NaN, muted: false })
      expect(adPlayer.video.volume).toBe(1)
    })
  })

  describe('events', () => {
    it('reports loaded once and started once per creative, and playback changes by anyone', async () => {
      const { adPlayer, media, heard, listener } = player()
      await adPlayer.load(A, listener, { volume: 1, muted: false })
      expect(heard).toEqual(['wants playback', 'loaded', 'started'])

      adPlayer.pause()
      await settle()
      adPlayer.play()
      await settle()
      expect(heard.slice(3)).toEqual(['stopped', 'wants playback'])
      expect(heard.filter((entry) => entry === 'started'), 'resuming is not starting').toHaveLength(1)

      media.reachEnd()
      expect(heard.slice(5), 'the pause an element makes at its end is not a pause').toEqual(['ended'])
    })

    it('reports loaded before started when the element skips straight to playing', async () => {
      const { adPlayer, media, heard, listener } = player()
      media.autoStart = false
      void adPlayer.load(A, listener, { volume: 1, muted: false })
      await settle()
      // Some engines fire `playing` without a `loadeddata` the page saw.
      media.readyState = 4
      adPlayer.video.dispatchEvent(new Event('playing'))

      expect(heard).toEqual(['wants playback', 'loaded', 'started'])
    })

    it('reports a MediaError mid-stream through the listener', async () => {
      const { adPlayer, media, heard, listener } = player()
      await adPlayer.load(A, listener, { volume: 1, muted: false })
      media.fail(MEDIA_ERR.DECODE)
      expect(heard[heard.length - 1]).toBe(`failed ${VastError.MEDIA_FILE_DISPLAY_PROBLEM}`)
    })

    it('says nothing once the creative is let go of', async () => {
      const { adPlayer, media, heard, listener } = player()
      await adPlayer.load(A, listener, { volume: 1, muted: false })
      const before = heard.length
      adPlayer.unload()
      media.fail(MEDIA_ERR.NETWORK)
      media.reachEnd()
      adPlayer.video.dispatchEvent(new Event('playing'))
      await settle()

      expect(heard).toHaveLength(before)
      expect(adPlayer.video.hasAttribute('src')).toBe(false)
    })
  })

  it('wants playback only while a creative is loaded and the element is not paused', async () => {
    const { adPlayer, listener } = player()
    expect(adPlayer.wantsPlayback).toBe(false)
    await adPlayer.load(A, listener, { volume: 1, muted: false })
    expect(adPlayer.wantsPlayback).toBe(true)
    adPlayer.pause()
    expect(adPlayer.wantsPlayback).toBe(false)
    adPlayer.play()
    adPlayer.unload()
    expect(adPlayer.wantsPlayback).toBe(false)
  })

  it('ignores play and pause with no creative', () => {
    const { adPlayer, media } = player()
    adPlayer.play()
    adPlayer.pause()
    expect(media.calls).toEqual([])
  })

  it('restores a zero volume when unmuted, so unmuting is audible', async () => {
    const { adPlayer, listener } = player()
    await adPlayer.load(A, listener, { volume: 0, muted: true })
    adPlayer.setMuted(false)
    expect([adPlayer.video.muted, adPlayer.video.volume]).toEqual([false, 1])
  })

  it('touches the element in prepare() only before it has a creative', async () => {
    const { adPlayer, media, listener } = player()
    adPlayer.prepare()
    expect(media.calls).toEqual(['load'])
    await adPlayer.load(A, listener, { volume: 1, muted: false })
    const calls = media.calls.length
    adPlayer.prepare()
    expect(media.calls).toHaveLength(calls)
  })

  it('shows and hides its layer, and removes it on destroy', async () => {
    const host = container()
    const { adPlayer, media, heard, listener } = player(host)
    adPlayer.show()
    expect(adPlayer.layer.style.display).toBe('block')
    adPlayer.hide()
    expect(adPlayer.layer.style.display).toBe('none')

    await adPlayer.load(A, listener, { volume: 1, muted: false })
    const before = heard.length
    adPlayer.destroy()
    media.reachEnd()

    expect(host.contains(adPlayer.layer)).toBe(false)
    expect(heard).toHaveLength(before)
  })
})

// MARK: - The clock

describe('VastVideoClock', () => {
  function clockOn(source = A) {
    const video = document.createElement('video')
    const media = new ScriptedMedia(video)
    video.src = source
    media.paused = false
    media.readyState = 4
    media.duration = 30
    media.currentTime = 12.5
    let now = 100
    const ticks: VastTick[] = []
    const clock = new VastVideoClock(video, A, () => now, 200)
    return {
      video,
      media,
      ticks,
      clock,
      start: () => clock.start((tick) => ticks.push(tick)),
      setNow: (value: number) => {
        now = value
      },
    }
  }

  it('ticks at once, then every interval, until stopped — and again after a restart', () => {
    useFakeTimers()
    const c = clockOn()
    c.start()
    expect(c.ticks).toHaveLength(1)
    vi.advanceTimersByTime(600)
    expect(c.ticks).toHaveLength(4)

    c.clock.stop()
    vi.advanceTimersByTime(600)
    expect(c.ticks).toHaveLength(4)

    c.start()
    vi.advanceTimersByTime(200)
    expect(c.ticks).toHaveLength(6)
    c.clock.stop()
  })

  it('reads the playhead, the real duration, the rate and the wall clock off the element', () => {
    const c = clockOn()
    c.setNow(250)
    c.start()
    c.clock.stop()

    expect(c.ticks[0]).toEqual({ adTime: 12.5, duration: 30, rate: 1, wallClock: 250, itemIsOurs: true, isMuted: false })
  })

  it.each([
    ['paused', (m: ScriptedMedia) => void (m.paused = true)],
    ['seeking', (m: ScriptedMedia) => void (m.seeking = true)],
    ['starved of data', (m: ScriptedMedia) => void (m.readyState = 2)],
    ['ended', (m: ScriptedMedia) => void (m.ended = true)],
  ])('reports rate 0 while %s, because quartiles only count at normal speed', (_, change) => {
    const c = clockOn()
    change(c.media)
    c.start()
    c.clock.stop()
    expect(c.ticks[0]!.rate).toBe(0)
  })

  it('reports a duration it cannot trust as unknown', () => {
    const c = clockOn()
    c.media.duration = Number.POSITIVE_INFINITY
    c.start()
    c.media.duration = Number.NaN
    c.clock.stop()
    c.start()
    c.clock.stop()
    expect(c.ticks.map((tick) => tick.duration)).toEqual([null, null])
  })

  it('says when the element is no longer on its creative', () => {
    const c = clockOn(B)
    c.start()
    c.clock.stop()
    expect(c.ticks[0]).toMatchObject({ itemIsOurs: false, adTime: 0, duration: null })
  })

  it('matches a relative creative URL against the absolute currentSrc', () => {
    const video = document.createElement('video')
    const media = new ScriptedMedia(video)
    video.src = 'https://cdn.test/media/a.mp4'
    media.readyState = 4
    const ticks: VastTick[] = []
    const clock = new VastVideoClock(video, 'https://cdn.test/media/./a.mp4', () => 0)
    clock.start((tick) => ticks.push(tick))
    clock.stop()
    expect(ticks[0]!.itemIsOurs).toBe(true)
  })

  it('counts a zero volume as muted', () => {
    const c = clockOn()
    c.video.volume = 0
    c.start()
    c.clock.stop()
    expect(c.ticks[0]!.isMuted).toBe(true)
  })
})

// MARK: - The content

describe('htmlVideoContent', () => {
  function content(options: { playing?: boolean; controls?: boolean; autoplay?: boolean } = {}) {
    const video = document.createElement('video')
    const media = new ScriptedMedia(video)
    video.controls = options.controls ?? true
    video.autoplay = options.autoplay ?? false
    media.paused = !(options.playing ?? true)
    media.readyState = 4
    media.currentTime = 30
    return { video, media, player: htmlVideoContent(video) }
  }

  it('pauses and hides the controls for the break, then puts both back and plays on', () => {
    const { video, media, player } = content()
    player.pauseForBreak()
    expect(media.paused).toBe(true)
    expect(video.controls).toBe(false)

    player.resumeAfterBreak()
    expect(video.controls).toBe(true)
    expect(media.paused).toBe(false)
  })

  it('gives back controls the host had hidden as hidden, and leaves paused content paused', () => {
    const { video, media, player } = content({ playing: false, controls: false })
    player.pauseForBreak()
    player.resumeAfterBreak()
    expect(video.controls).toBe(false)
    expect(media.calls).not.toContain('play')
  })

  it('plays content that was about to autoplay when a pre-roll stopped it', () => {
    const { media, player } = content({ playing: false, autoplay: true })
    player.pauseForBreak()
    player.resumeAfterBreak()
    expect(media.paused).toBe(false)
  })

  it('puts back a playhead that moved during the break', () => {
    const { media, player } = content()
    player.pauseForBreak()
    media.currentTime = 95
    player.resumeAfterBreak()
    expect(media.currentTime).toBe(30)
  })

  it('is idempotent both ways', () => {
    const { video, media, player } = content()
    player.pauseForBreak()
    video.controls = false
    player.pauseForBreak()
    player.resumeAfterBreak()
    player.resumeAfterBreak()
    expect(video.controls, 'the second pause must not save the hidden state').toBe(true)
    expect(media.calls.filter((call) => call === 'play')).toHaveLength(1)
  })

  it('leaves iPhone native fullscreen before the break, where nothing can be drawn over it', () => {
    const { video, player } = content()
    const exit = vi.fn()
    Object.assign(video, { webkitDisplayingFullscreen: true, webkitExitFullscreen: exit })
    player.pauseForBreak()
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('reads volume, muted and the playhead live', () => {
    const { video, media, player } = content()
    video.volume = 0.25
    video.muted = true
    media.currentTime = 12
    expect([player.volume, player.muted, player.currentTime]).toEqual([0.25, true, 12])
  })
})

// MARK: - The media controls

describe('VastMediaSessionLock', () => {
  const ad = (title: string | null) => createAd({ id: 'a1', title, advertiser: 'Brand', linear: createLinear({ duration: 10 }) })

  it('keeps the host metadata from before the first ad, across a pod', () => {
    const session = new FakeMediaSession()
    const film = { title: 'Film' }
    session.metadata = film
    const lock = new VastMediaSessionLock('Advertisement', session)
    const handlers = { play: () => undefined, pause: () => undefined }

    lock.engage(ad('First'), handlers)
    lock.engage(ad(null), handlers)
    expect(session.metadata).toMatchObject({ title: 'Advertisement', artist: 'Brand' })

    lock.release()
    expect(session.metadata).toBe(film)
    lock.release()
    expect(session.metadata).toBe(film)
  })

  it('survives a browser that does not know an action', () => {
    const session = new FakeMediaSession()
    session.setActionHandler = (action: string) => {
      if (action === 'skipad') throw new TypeError('unknown action')
    }
    const lock = new VastMediaSessionLock('Advertisement', session)
    expect(() => lock.engage(ad('Spot'), { play: () => undefined, pause: () => undefined })).not.toThrow()
    expect(() => lock.release()).not.toThrow()
  })

  it('does nothing where there is no media session', () => {
    const lock = new VastMediaSessionLock('Advertisement', null)
    expect(() => lock.engage(ad('Spot'), { play: () => undefined, pause: () => undefined })).not.toThrow()
  })
})

// MARK: - Strings

describe('vastStringsFor', () => {
  it('gives Armenian for hy and its regions, English otherwise', () => {
    expect(vastStringsFor('hy')).toBe(VAST_STRINGS_HY)
    expect(vastStringsFor('hy-AM')).toBe(VAST_STRINGS_HY)
    expect(vastStringsFor('en-US')).toBe(VAST_STRINGS_EN)
    expect(vastStringsFor('ru')).toBe(VAST_STRINGS_EN)
  })

  it("reads the page's own language when given none", () => {
    const previous = document.documentElement.lang
    document.documentElement.lang = 'hy'
    try {
      expect(vastStringsFor()).toBe(VAST_STRINGS_HY)
    } finally {
      document.documentElement.lang = previous
    }
  })

  it('formats the pod badge and the countdowns', () => {
    expect(VAST_STRINGS_EN.adBadgePod(2, 3)).toBe('Ad 2/3')
    expect(VAST_STRINGS_EN.skipCountdown(5)).toBe('Skip in 5')
    expect(VAST_STRINGS_HY.countdown(7)).toBe('7 վրկ')
  })
})
