import { afterEach, describe, expect, it, vi } from 'vitest'
import { VastAdOverlay, type VastAdOverlayOptions } from '../src/VastAdOverlay.js'
import { VAST_STRINGS_EN } from '../src/VastStrings.js'
import { disposeHarnesses, harness, inLine, response, TAG, type HarnessOptions } from './harness.js'

/**
 * The overlay owns the two things in the ad UI that are requirements rather
 * than decoration — a skip control for a skippable ad (§2.3) and a click path
 * (§3.10.1) — so these tests are about what it offers and when, not how it looks.
 */

const overlays: VastAdOverlay[] = []

afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.destroy()
  disposeHarnesses()
})

async function onScreen(options: HarnessOptions, overlayOptions: VastAdOverlayOptions = {}) {
  const h = harness(options)
  const overlay = new VastAdOverlay(h.session, { strings: VAST_STRINGS_EN, ...overlayOptions })
  overlays.push(overlay)
  const done = h.session.playBreak(TAG, { position: 'preroll' })
  await h.settle()
  const find = <T extends HTMLElement>(name: string) => overlay.root.querySelector<T>(`.vast-${name}`)!
  return {
    h,
    overlay,
    done,
    badge: find<HTMLDivElement>('badge'),
    skip: find<HTMLButtonElement>('skip'),
    click: find<HTMLButtonElement>('click'),
    learnMore: find<HTMLButtonElement>('learn-more'),
    unmute: find<HTMLButtonElement>('unmute'),
  }
}

/** jsdom lays nothing out; a control measures what the test says it drew at. */
function drawnAt(element: HTMLElement, width: number, height: number): void {
  element.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) })
}

describe('VastAdOverlay', () => {
  it('draws into the session layer, above the ad, and nothing while no ad is on screen', () => {
    const h = harness()
    const overlay = new VastAdOverlay(h.session)
    overlays.push(overlay)

    expect(h.session.adPlayer.layer.lastElementChild).toBe(overlay.root)
    expect(overlay.root.hidden).toBe(true)
  })

  it('names the ad and counts it down', async () => {
    const { h, overlay, badge } = await onScreen({ documents: { [TAG]: inLine('a1') } })
    h.tick(2.2, { duration: 10 })

    expect(overlay.root.hidden).toBe(false)
    expect(badge.textContent).toBe('Ad · 8s')
  })

  it('says where the ad sits in a pod', async () => {
    const { badge } = await onScreen({ documents: { [TAG]: response({ id: 'p1', sequence: 1 }, { id: 'p2', sequence: 2 }) } })

    expect(badge.textContent).toContain('Ad 1/2')
  })

  it('counts the skip down, then offers it, and skips when used', async () => {
    const { h, skip } = await onScreen({ documents: { [TAG]: inLine({ id: 'a1', skipOffset: '00:00:05' }) } })
    h.play(0, 2)

    expect(skip.hidden).toBe(false)
    expect(skip.textContent).toBe('Skip in 3')
    expect(skip.getAttribute('aria-disabled')).toBe('true')
    skip.click()
    expect(h.events, 'a control that is not yet due does nothing').not.toContain('finished a1 skipped')

    h.play(2, 5)
    expect(skip.textContent).toBe(VAST_STRINGS_EN.skipAction)
    expect(skip.getAttribute('aria-disabled')).toBe('false')
    skip.click()

    expect(h.events).toContain('finished a1 skipped')
    expect(h.reported).toContain('skip')
  })

  it('offers no skip for an ad that declares no skipoffset', async () => {
    const { h, skip } = await onScreen({ documents: { [TAG]: inLine('a1') } })
    h.play(0, 8)

    expect(skip.hidden).toBe(true)
  })

  it("leaves the skip to the host under 'host' presentation", async () => {
    const { h, skip, overlay } = await onScreen({
      documents: { [TAG]: inLine({ id: 'a1', skipOffset: '00:00:01' }) },
      configuration: { skipPresentation: 'host' },
    })
    h.play(0, 3)

    expect(overlay.root.hidden, 'the badge is still the SDK’s').toBe(false)
    expect(skip.hidden).toBe(true)
  })

  it('draws nothing at all when the response asked for host UI and the host allowed it', async () => {
    const { h, overlay } = await onScreen({
      documents: {
        [TAG]: inLine({
          id: 'a1',
          skipOffset: '00:00:01',
          extensions: '<Extension type="uiSettings"><UiHideable>1</UiHideable></Extension>',
        }),
      },
      configuration: { allowsHiddenUi: true },
    })
    h.play(0, 2)

    expect(overlay.root.hidden).toBe(true)
  })

  it('keeps its UI when the response asked for host UI but the host never agreed to draw it', async () => {
    const { h, overlay, skip } = await onScreen({
      documents: {
        [TAG]: inLine({
          id: 'a1',
          skipOffset: '00:00:01',
          extensions: '<Extension type="uiSettings"><UiHideable>1</UiHideable></Extension>',
        }),
      },
    })
    h.play(0, 2)

    expect(overlay.root.hidden).toBe(false)
    expect(skip.hidden).toBe(false)
  })

  describe('the click path', () => {
    it('makes the whole ad clickable, and a Learn more button, when it has somewhere to go', async () => {
      const opened: string[] = []
      const { h, click, learnMore } = await onScreen(
        { documents: { [TAG]: inLine({ id: 'a1', clickThrough: 'https://advertiser.test/' }) } },
        { onClickThrough: (url) => opened.push(url) },
      )

      expect(click.hidden).toBe(false)
      expect(learnMore.hidden).toBe(false)
      click.click()
      learnMore.click()

      expect(opened).toEqual(['https://advertiser.test/', 'https://advertiser.test/'])
      expect(h.reported.filter((label) => label === 'clickTracking')).toHaveLength(2)
    })

    it('lets go of focus once clicked, so a Space meant for the player is not a second click-through', async () => {
      const opened: string[] = []
      const { click } = await onScreen(
        { documents: { [TAG]: inLine({ id: 'a1', clickThrough: 'https://advertiser.test/' }) } },
        { onClickThrough: (url) => opened.push(url) },
      )
      click.focus()
      expect(document.activeElement).toBe(click)

      click.click()

      expect(document.activeElement).not.toBe(click)
      expect(opened).toHaveLength(1)
    })

    it('keeps the click layer out of the tab order: it is a pointer target', async () => {
      const { click } = await onScreen({ documents: { [TAG]: inLine({ id: 'a1', clickThrough: 'https://advertiser.test/' }) } })

      expect(click.tabIndex).toBe(-1)
    })

    it('offers no click path for an ad with nowhere to go', async () => {
      const { click, learnMore } = await onScreen({ documents: { [TAG]: inLine('a1') } })

      expect(click.hidden).toBe(true)
      expect(learnMore.hidden).toBe(true)
    })

    it("draws none under 'host' or 'disabled' click presentation", async () => {
      for (const clickPresentation of ['host', 'disabled'] as const) {
        const { click, learnMore } = await onScreen({
          documents: { [TAG]: inLine({ id: 'a1', clickThrough: 'https://advertiser.test/' }) },
          configuration: { clickPresentation },
        })
        expect(click.hidden, clickPresentation).toBe(true)
        expect(learnMore.hidden, clickPresentation).toBe(true)
      }
    })

    it('opens a new tab from inside the click by default', async () => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      const { learnMore } = await onScreen({ documents: { [TAG]: inLine({ id: 'a1', clickThrough: 'https://advertiser.test/' }) } })

      learnMore.click()

      expect(open).toHaveBeenCalledWith('https://advertiser.test/', '_blank', 'noopener,noreferrer')
      open.mockRestore()
    })
  })

  it('offers to unmute when the browser started the ad muted, and unmutes as the viewer asked', async () => {
    const { h, unmute } = await onScreen({ documents: { [TAG]: inLine('a1') }, autoplay: 'mutedOnly' })

    expect(h.snapshot.mutedByAutoplayPolicy).toBe(true)
    expect(unmute.hidden).toBe(false)
    expect(unmute.textContent).toBe(VAST_STRINGS_EN.unmute)
    unmute.click()

    expect(h.snapshot.isMuted).toBe(false)
    expect(h.reported).toContain('unmute')
    expect(unmute.hidden).toBe(true)
  })

  describe('the skip control as the session measures it', () => {
    it('is measured where it is drawn: a usable control is not reported', async () => {
      const { h, skip } = await onScreen({ documents: { [TAG]: inLine({ id: 'a1', skipOffset: '00:00:01' }) } })
      drawnAt(skip, 120, 44)
      h.play(0, 2)

      expect(h.unavailable).toEqual([])
    })

    it('is reported when a stylesheet shrinks it below what a viewer can hit', async () => {
      const { h, skip } = await onScreen({ documents: { [TAG]: inLine({ id: 'a1', skipOffset: '00:00:01' }) } })
      drawnAt(skip, 10, 10)
      h.play(0, 2)

      expect(h.unavailable).toHaveLength(1)
      expect(h.unavailable[0]).toContain('10×10px')
    })

    it('is reported as missing once the overlay is gone', async () => {
      const { h, overlay } = await onScreen({ documents: { [TAG]: inLine({ id: 'a1', skipOffset: '00:00:01' }) } })
      overlay.destroy()
      h.play(0, 2)

      expect(h.unavailable).toHaveLength(1)
      expect(h.unavailable[0]).toContain('no VastAdOverlay is mounted')
    })
  })

  it('leaves the layer as it found it when destroyed', async () => {
    const { h, overlay } = await onScreen({ documents: { [TAG]: inLine('a1') } })
    overlay.destroy()

    expect(h.session.adPlayer.layer.contains(overlay.root)).toBe(false)
  })
})
