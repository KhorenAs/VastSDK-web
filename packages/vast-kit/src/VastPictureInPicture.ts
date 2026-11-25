import { VastLog } from './VastLog.js'

/**
 * How long a break waits for the browser to move the PiP window before it goes
 * on without it. Chrome swaps the video inside the open window; Safari can only
 * have one element in PiP, so it closes the window — animating it back into the
 * page — and opens another, which takes noticeably longer. A request still
 * unanswered after this is left to finish on its own.
 */
const HANDOFF_TIMEOUT_MS = 3000

interface WebKitPresentation {
  webkitPresentationMode?: string
}

/**
 * Whether `video` is the element in the PiP window.
 *
 * `document.pictureInPictureElement` alone is not enough in Safari. When one
 * element takes the window from another, WebKit reports the old element's exit
 * on its own schedule, and an exit that lands after the new element's entry
 * empties `pictureInPictureElement` while the new element is still in the
 * window. The element's own `webkitPresentationMode` stays right.
 */
export function isInPictureInPicture(video: HTMLVideoElement | null | undefined): boolean {
  if (!video) return false
  return video.ownerDocument.pictureInPictureElement === video ||
    (video as HTMLVideoElement & WebKitPresentation).webkitPresentationMode === 'picture-in-picture'
}

/**
 * Moves an existing native PiP window from the content to the ad and back,
 * without changing the content's media source.
 *
 * The ad element's own PiP is switched on only for the handoff, and switched
 * off again only once no request is in flight and the ad is out of the window:
 * Chrome closes the window of an element whose `disablePictureInPicture` turns
 * on, so switching it off under a slow handoff would throw the ad out of the
 * window it was just given.
 *
 * Every step is logged through {@link VastLog}: what a browser does with a PiP
 * window cannot be seen from a test, only from the browser.
 */
export class VastPictureInPicture {
  private content: HTMLVideoElement | null = null
  /** The ad's own request, settled however it went. */
  private entering: Promise<void> | null = null
  private restoring: Promise<void> | null = null
  /** Requests the browser has not answered yet. */
  private pending = 0

  constructor(private readonly ad: HTMLVideoElement) {}

  get active(): boolean {
    return isInPictureInPicture(this.ad)
  }

  /** Whether `content` has a PiP window open that the ad could take over. */
  canTakeOver(content: HTMLVideoElement | null | undefined): boolean {
    return isInPictureInPicture(content) && typeof this.ad.requestPictureInPicture === 'function'
  }

  enter(content: HTMLVideoElement | null | undefined): void {
    if (this.content || !content || !this.canTakeOver(content)) return
    this.content = content
    this.setAdPictureInPictureDisabled(false)
    VastLog.notice(`PiP: moving the window from the content to the ad (${this.describe(content)})`)
    this.entering = this.track('the ad', content, () => this.ad.requestPictureInPicture())
  }

  restore(): Promise<void> | null {
    if (this.restoring) return this.restoring
    const content = this.content
    if (!content) return null
    this.restoring = this.restoreContent(content)
    return this.restoring
  }

  private async restoreContent(content: HTMLVideoElement): Promise<void> {
    try {
      // Normally settled long ago: it was asked for when the ad started.
      if (this.entering) await withTimeout(this.entering)
      if (!this.active) {
        // Closing PiP or selecting another video during the break is the viewer's choice.
        VastLog.notice(`PiP: the ad is no longer in the window; leaving it as it is (${this.describe(content)})`)
        return
      }
      if (content.isConnected) {
        VastLog.notice(`PiP: moving the window back to the content (${this.describe(content)})`)
        await withTimeout(this.track('the content', content, () => content.requestPictureInPicture()))
      }
      if (this.active && this.pending === 0) {
        // The ad is about to be unloaded; an empty window left behind would be all the viewer had.
        VastLog.warning(`PiP: the content could not take the window back, so it is closed (${this.describe(content)})`)
        await withTimeout(this.exit(content))
      }
    } finally {
      this.content = null
      this.entering = null
      this.restoring = null
      this.disableAdWhenSettled()
    }
  }

  private exit(content: HTMLVideoElement): Promise<void> {
    const doc = this.ad.ownerDocument
    if (typeof doc.exitPictureInPicture === 'function' && doc.pictureInPictureElement) {
      return this.track('nothing', content, () => doc.exitPictureInPicture())
    }
    // WebKit with an emptied pictureInPictureElement: the element can still leave by its own mode.
    const webkit = this.ad as HTMLVideoElement & { webkitSetPresentationMode?: (mode: string) => void }
    if (typeof webkit.webkitSetPresentationMode === 'function') {
      return this.track('nothing', content, async () => webkit.webkitSetPresentationMode!('inline'))
    }
    return Promise.resolve()
  }

  /** One request to the browser. Settles when the browser answers, and never rejects. */
  private track(what: string, content: HTMLVideoElement, request: () => Promise<unknown>): Promise<void> {
    this.pending++
    let answer: Promise<unknown>
    try {
      answer = request()
    } catch (error) {
      answer = Promise.reject(error)
    }
    return answer
      .then(
        () => VastLog.notice(`PiP: ${what} has the window now (${this.describe(content)})`),
        // The browser may refuse a handoff. Playback on the page still works.
        (error: unknown) => VastLog.warning(`PiP: the browser refused ${what} the window: ${describeError(error)} (${this.describe(content)})`),
      )
      .then(() => {
        this.pending--
        this.disableAdWhenSettled()
      })
  }

  private disableAdWhenSettled(): void {
    if (this.content || this.pending > 0 || this.active) return
    this.setAdPictureInPictureDisabled(true)
  }

  private setAdPictureInPictureDisabled(disabled: boolean): void {
    this.ad.disablePictureInPicture = disabled
    this.ad.toggleAttribute('disablepictureinpicture', disabled)
  }

  /** Who the browser says is in the window, both ways it says it. */
  private describe(content: HTMLVideoElement): string {
    const element = this.ad.ownerDocument.pictureInPictureElement
    const name = element === this.ad ? 'ad' : element === content ? 'content' : element ? 'another video' : 'none'
    const mode = (video: HTMLVideoElement): string =>
      (video as HTMLVideoElement & WebKitPresentation).webkitPresentationMode ?? 'n/a'
    return `pictureInPictureElement: ${name}, ad: ${mode(this.ad)}, content: ${mode(content)}`
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)) {
    const { name, message } = error as { name?: unknown; message?: unknown }
    return `${String(name)}: ${String(message)}`
  }
  return String(error)
}

/** The promise, or nothing once {@link HANDOFF_TIMEOUT_MS} has passed. */
async function withTimeout(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, HANDOFF_TIMEOUT_MS) })])
  } finally {
    clearTimeout(timer)
  }
}
