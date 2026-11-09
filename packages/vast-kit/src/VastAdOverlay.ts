import { isSkippable } from '@kinodaran/vast-core'
import type { VastAdSession } from './VastAdSession.js'
import type { VastAdSnapshot } from './VastAdSessionTypes.js'
import { vastStringsFor, type VastStrings } from './VastStrings.js'

export interface VastAdOverlayOptions {
  /** The overlay's words: a full set, or a language tag (`hy`, `en`). Default: the page's `<html lang>`. */
  readonly strings?: VastStrings | string
  /**
   * Opens a click-through. Default: a new tab, from inside the click itself —
   * browsers only let a page open one during a gesture.
   */
  readonly onClickThrough?: (url: string) => void
  /** Extra class on the overlay's root, for a host restyling it. */
  readonly className?: string
}

/**
 * The ad UI: the badge, the countdown, the skip control, the click path, and an
 * unmute control when the browser imposed silence.
 *
 * Two of those are requirements, not decoration: a skippable ad must be offered
 * a skip control (§2.3), and the ad must be clickable (§3.10.1). The rest is
 * what a viewer needs to know an ad is an ad and when it ends.
 *
 * Drawn in the session's own layer, over the ad's video, so it follows the
 * player into fullscreen and can never end up under the host's skin. Every
 * element has a stable class name and the look is set through CSS custom
 * properties (`--vast-*`), so the host owns the style while the SDK owns the
 * behaviour. A host that wants its own UI altogether — React, say — skips this
 * class, reads `session.getSnapshot()`, and sets `skipPresentation: 'host'`.
 */
export class VastAdOverlay {
  readonly root: HTMLDivElement

  private readonly strings: VastStrings
  private readonly badge: HTMLDivElement
  private readonly skipButton: HTMLButtonElement
  private readonly clickLayer: HTMLButtonElement
  private readonly learnMore: HTMLButtonElement
  private readonly unmuteButton: HTMLButtonElement
  private readonly disposers: Array<() => void> = []
  private wasSkippable = false

  constructor(
    private readonly session: VastAdSession,
    private readonly options: VastAdOverlayOptions = {},
  ) {
    const layer = session.adPlayer.layer
    const doc = layer.ownerDocument
    installStyles(doc)
    this.strings = typeof options.strings === 'object' ? options.strings : vastStringsFor(options.strings)

    this.root = element(doc, 'div', 'vast-overlay')
    if (options.className) this.root.classList.add(...options.className.split(/\s+/).filter(Boolean))

    // The whole surface is the click path (§3.10.1 — the URI "the media player
    // opens when a viewer clicks the ad"); it sits under every other control.
    this.clickLayer = element(doc, 'button', 'vast-click')
    this.clickLayer.type = 'button'
    this.clickLayer.tabIndex = -1
    this.clickLayer.setAttribute('aria-label', this.strings.learnMore)

    this.badge = element(doc, 'div', 'vast-badge')
    this.badge.setAttribute('aria-live', 'off')

    this.learnMore = element(doc, 'button', 'vast-learn-more')
    this.learnMore.type = 'button'
    this.learnMore.textContent = this.strings.learnMore

    this.unmuteButton = element(doc, 'button', 'vast-unmute')
    this.unmuteButton.type = 'button'

    this.skipButton = element(doc, 'button', 'vast-skip')
    this.skipButton.type = 'button'

    this.root.append(this.clickLayer, this.badge, this.learnMore, this.unmuteButton, this.skipButton)
    layer.appendChild(this.root)

    this.listen(this.clickLayer, 'click', () => {
      // The layer is a pointer target, not a keyboard one. A mouse click still
      // focuses a button, and a focused button answers Space and Enter — so a
      // viewer pressing Space for "pause" a moment later would be sent to the
      // advertiser a second time. It lets go of focus as soon as it is used.
      this.clickLayer.blur()
      this.openClickThrough()
    })
    this.listen(this.learnMore, 'click', () => this.openClickThrough())
    this.listen(this.unmuteButton, 'click', () => this.session.setMuted(!this.session.getSnapshot().isMuted))
    this.listen(this.skipButton, 'click', () => {
      if (!this.session.getSnapshot().canSkip) return
      try {
        this.session.skip()
      } catch {
        // The control only offers a skip the session agreed was due; a race
        // with the ad ending is the only way here, and there is nothing to do.
      }
    })

    // The control is measured where it is drawn, so a host stylesheet that
    // hides or shrinks it is caught rather than leaving a skippable ad
    // unskippable without anyone knowing.
    this.disposers.push(
      session.registerSkipControl(() => {
        if (this.skipButton.hidden || !this.skipButton.isConnected) return null
        const rect = this.skipButton.getBoundingClientRect()
        const style = doc.defaultView?.getComputedStyle(this.skipButton)
        if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) {
          return { width: 0, height: 0 }
        }
        return { width: rect.width, height: rect.height }
      }),
    )
    this.disposers.push(session.subscribe(() => this.render(session.getSnapshot())))
    this.render(session.getSnapshot())
  }

  destroy(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.root.remove()
  }

  private openClickThrough(): void {
    const custom = this.options.onClickThrough
    if (custom) {
      const url = this.session.click()
      if (url) custom(url)
    } else {
      this.session.openClickThrough()
    }
  }

  private render(snapshot: VastAdSnapshot): void {
    const ad = snapshot.currentAd
    const onScreen = ad !== null && (snapshot.state.type === 'playing' || snapshot.state.type === 'paused')
    // A response that asked for host-drawn UI, from a host that allowed it,
    // gets nothing from the SDK — skip included; the host draws all of it.
    this.root.hidden = !onScreen || snapshot.suppressesAdUi
    if (this.root.hidden || !ad) return

    const position = snapshot.adPosition
    const badge = position.total > 1 ? this.strings.adBadgePod(position.index, position.total) : this.strings.adBadge
    this.badge.textContent = `${badge} · ${this.strings.countdown(Math.max(0, Math.ceil(snapshot.remainingTime)))}`

    const clickable = this.session.configuration.clickPresentation === 'surface' && ad.linear.clickThrough !== null
    this.clickLayer.hidden = !clickable
    this.learnMore.hidden = !clickable

    this.unmuteButton.hidden = !snapshot.isMuted
    this.unmuteButton.textContent = snapshot.mutedByAutoplayPolicy ? this.strings.unmute : '🔇'
    this.unmuteButton.setAttribute('aria-label', this.strings.unmute)

    const skippable = isSkippable(ad) && snapshot.effectiveSkipPresentation === 'sdk'
    this.skipButton.hidden = !skippable
    if (!skippable) {
      this.wasSkippable = false
      return
    }
    const unlocked = snapshot.canSkip
    this.skipButton.setAttribute('aria-disabled', String(!unlocked))
    this.skipButton.classList.toggle('vast-skip--ready', unlocked)
    this.skipButton.textContent = unlocked
      ? this.strings.skipAction
      : this.strings.skipCountdown(Math.max(1, Math.ceil(snapshot.timeUntilSkip ?? 0)))
    // On a television the control has to take focus when it unlocks — a
    // remote has no pointer to reach it with. Elsewhere focus is left where
    // the viewer put it.
    if (unlocked && !this.wasSkippable && this.session.isTelevision) this.skipButton.focus({ preventScroll: true })
    this.wasSkippable = unlocked
  }

  private listen(target: HTMLElement, event: string, handler: (event: Event) => void): void {
    const wrapped = (e: Event): void => {
      e.stopPropagation()
      handler(e)
    }
    target.addEventListener(event, wrapped)
    this.disposers.push(() => target.removeEventListener(event, wrapped))
  }
}

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag)
  el.className = className
  return el
}

const STYLE_ID = 'vast-overlay-styles'

/**
 * One stylesheet per document, low in specificity so a host's own rules win.
 * Every colour, size and offset reads a `--vast-*` custom property first.
 */
function installStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.vast-overlay{position:absolute;inset:0;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:1;
  font:var(--vast-font,500 14px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Armenian",sans-serif);
  color:var(--vast-fg,#fff);-webkit-tap-highlight-color:transparent}
.vast-overlay[hidden],.vast-overlay [hidden]{display:none!important}
.vast-overlay button{pointer-events:auto;font:inherit;color:inherit;cursor:pointer;margin:0}
.vast-overlay button:focus-visible{outline:3px solid var(--vast-focus,#fff);outline-offset:2px}
.vast-click{position:absolute;inset:0;top:0;left:0;width:100%;height:100%;background:transparent;border:0;padding:0}
.vast-badge{position:absolute;top:var(--vast-inset,12px);left:var(--vast-inset,12px);padding:4px 8px;border-radius:4px;
  background:var(--vast-chip-bg,rgba(0,0,0,.6));pointer-events:none;font-variant-numeric:tabular-nums}
.vast-learn-more{position:absolute;left:var(--vast-inset,12px);bottom:var(--vast-inset,12px);padding:8px 12px;min-height:36px;
  border-radius:4px;border:0;background:var(--vast-chip-bg,rgba(0,0,0,.6))}
.vast-unmute{position:absolute;top:var(--vast-inset,12px);right:var(--vast-inset,12px);padding:8px 12px;min-height:36px;
  border-radius:4px;border:0;background:var(--vast-chip-bg,rgba(0,0,0,.6))}
.vast-skip{position:absolute;right:0;bottom:var(--vast-skip-bottom,56px);min-width:120px;min-height:44px;padding:10px 18px;
  border:1px solid var(--vast-skip-border,rgba(255,255,255,.55));border-right:0;background:var(--vast-skip-bg,rgba(0,0,0,.72));
  font-variant-numeric:tabular-nums;text-align:center}
.vast-skip[aria-disabled="true"]{cursor:default;opacity:.85}
.vast-skip--ready{background:var(--vast-skip-ready-bg,rgba(0,0,0,.85))}
`
  ;(doc.head ?? doc.documentElement).appendChild(style)
}
