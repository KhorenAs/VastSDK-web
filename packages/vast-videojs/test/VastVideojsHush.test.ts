import { afterEach, expect, it } from 'vitest'
import videojs from 'video.js'
import { videojsContent, type VideoJsPlayerLike } from '../src/VastVideojs.js'

afterEach(() => {
  Reflect.deleteProperty(document, 'pictureInPictureElement')
  for (const id of Object.keys(videojs.getPlayers())) videojs.getPlayers()[id]?.dispose()
})

/**
 * Against the real Video.js, not a fake: what is being relied on is how its
 * event dispatcher treats an event, and only Video.js itself can answer that.
 */
it("keeps a lent element's media events from Video.js and from nobody else", () => {
  const element = document.createElement('video')
  document.body.appendChild(element)
  const player = videojs(element)
  const tech = player.el().querySelector('video')!
  Object.defineProperty(tech, 'currentSrc', { configurable: true, value: 'https://cdn.test/film.mp4' })
  Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: tech })

  const heardByPlayer: string[] = []
  for (const name of ['ended', 'timeupdate', 'loadstart', 'play']) player.on(name, () => heardByPlayer.push(name))
  // Safari's PiP window listens to the element itself, for its timeline.
  const heardByBrowser: string[] = []
  for (const name of ['durationchange', 'timeupdate', 'ended']) tech.addEventListener(name, () => heardByBrowser.push(name))

  // Video.js 8's own types allow `undefined` from its getters; the adapter's interface does not yet.
  const borrowed = videojsContent(player as unknown as VideoJsPlayerLike, { sameElementPiP: true }).borrowVideoForPiP?.()
  expect(borrowed?.video).toBe(tech)
  const hearAgain = borrowed!.hush!()
  for (const name of ['loadstart', 'durationchange', 'play', 'timeupdate', 'ended']) tech.dispatchEvent(new Event(name))
  expect(heardByPlayer, "the ad's events are not the film's").toEqual([])
  expect(heardByBrowser, "the browser's own controls still hear them").toEqual(['durationchange', 'timeupdate', 'ended'])

  hearAgain()
  tech.dispatchEvent(new Event('timeupdate'))
  expect(heardByPlayer).toEqual(['timeupdate'])
})
