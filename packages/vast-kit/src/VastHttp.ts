import type { VastBeacon, VastResourceLoader } from '@kinodaran/vast-core'
import { VastBeaconQueue, type VastQueuedBeacon } from './VastBeaconQueue.js'
import type { VastBeaconTransport } from './VastBeaconTransport.js'
import { VastLog } from './VastLog.js'

/**
 * Default transport: a plain `GET` per beacon, concurrently, with one retry —
 * and what fails is kept rather than lost.
 *
 * At-least-once delivery is safe by design: a VAST tracking URI carries its own
 * event identity, so a repeat is de-duplicated by the ad server rather than
 * double-counted. Anything that fails every attempt goes to
 * {@link VastBeaconQueue}, which persists it and hands it back on a later flush,
 * including after the page has been reloaded.
 *
 * **What a browser can know about delivery is less than a native app can.**
 * Tracking hosts do not send CORS headers, so a beacon goes out `no-cors` and
 * its response is opaque: the page learns that the request reached a server,
 * never which status the server answered. The Android and Apple transports
 * retry a 5xx and accept a 4xx; here any answer is final and only a request
 * that never got one — offline, DNS, a connection reset — is retried. Sending
 * with CORS to read the status would instead fail every beacon to every host
 * that does not answer it, which is nearly all of them.
 *
 * `keepalive` lets a request outlive the page that made it, the browser's
 * version of the Android SDK's process-wide delivery scope: a tab closing the
 * moment an ad completes must not take the `complete` request down with it.
 *
 * A failure still never interrupts playback. It is simply no longer forgotten.
 */
export class VastFetchTransport implements VastBeaconTransport {
  static readonly REQUEST_TIMEOUT_MILLIS = 5000

  private readonly maxAttempts: number

  constructor(
    /** `null` restores dropping what fails, which is only reasonable where something else is counting. */
    private readonly queue: VastBeaconQueue | null = VastBeaconQueue.shared(),
    maxAttempts = 2,
    /** Per request. A beacon that has not landed in a few seconds is not going to. */
    private readonly timeoutMillis = VastFetchTransport.REQUEST_TIMEOUT_MILLIS,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.maxAttempts = Math.max(1, maxAttempts)
  }

  async fire(beacons: readonly VastBeacon[]): Promise<void> {
    if (beacons.length === 0) return
    // Earlier failures ride along with current traffic, so a retry costs no
    // timer of its own and happens when the network is known to work — as
    // much as the queue's ration allows, which is one batch per interval for
    // the whole page, not the whole backlog with every beacon.
    const retries = this.queue?.takeForRetry() ?? []
    await this.deliver([...retries, ...beacons.map((b) => ({ url: b.url, recordedMillis: null }))])
  }

  /** Sends the next retry batch, with no new beacon to carry it — at session start, say. */
  async flushPending(): Promise<void> {
    const retries = this.queue?.takeForRetry() ?? []
    if (retries.length > 0) await this.deliver(retries)
  }

  /**
   * `recordedMillis` is `null` on a beacon's first send, and the moment it was
   * first held on a retry — so a beacon that keeps failing still ages out from
   * when it was recorded, not from its latest failure.
   */
  private async deliver(beacons: readonly Outgoing[]): Promise<void> {
    const results = await Promise.all(
      beacons.map(async (beacon) => {
        // A first send gets its immediate retry; a queued one has had that
        // already, and one attempt per batch is what keeps a dead tracker's
        // backlog from doubling every flush.
        const attempts = beacon.recordedMillis === null ? this.maxAttempts : 1
        return (await this.send(beacon.url, attempts)) ? null : beacon
      }),
    )
    const undelivered = results.filter((beacon): beacon is Outgoing => beacon !== null)
    if (undelivered.length === 0) return
    VastLog.warning(`${undelivered.length} beacon(s) undelivered`)
    this.queue?.enqueue(undelivered.filter((b) => b.recordedMillis === null).map((b) => b.url))
    this.queue?.requeue(
      undelivered
        .filter((b): b is VastQueuedBeacon => b.recordedMillis !== null)
        .map((b) => ({ recordedMillis: b.recordedMillis, url: b.url, retries: (b.retries ?? 0) + 1 })),
    )
  }

  /** @returns whether the beacon landed — or can never land, which is the same for the queue. */
  private async send(url: string, attempts: number): Promise<boolean> {
    if (!isFetchable(url)) {
      // Not a URL anyone could fetch, now or later: queueing it would only carry
      // it from flush to flush until it aged out.
      return true
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = typeof AbortController === 'undefined' ? null : new AbortController()
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMillis) : null
      try {
        await this.fetchImpl(url, {
          method: 'GET',
          mode: 'no-cors',
          credentials: 'include',
          cache: 'no-store',
          keepalive: true,
          redirect: 'follow',
          referrerPolicy: 'strict-origin-when-cross-origin',
          signal: controller?.signal,
        })
        return true
      } catch {
        // Network-level failure: worth another try, then the queue.
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }
    return false
  }
}

/**
 * Default loader for tags and Wrapper redirection: a CORS `fetch`, because the
 * page has to read the body.
 */
export class VastFetchLoader implements VastResourceLoader {
  constructor(
    private readonly credentials: RequestCredentials = 'include',
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async loadVast(url: string, timeoutSeconds: number, signal?: AbortSignal): Promise<string> {
    try {
      return await this.request(url, timeoutSeconds, this.credentials, signal)
    } catch (error) {
      // A server answering `Access-Control-Allow-Origin: *` makes a credentialed
      // read fail at the network level — indistinguishable, from here, from any
      // other network failure. One more try without cookies costs one round
      // trip and saves the break; an ad server that is simply down fails twice.
      // A timeout is no CORS refusal: retrying it would spend a second
      // per-hop timeout of the break's budget on a server that is not
      // answering, and leave no time to report the 301 to the wrappers.
      if (
        this.credentials !== 'include' ||
        signal?.aborted ||
        error instanceof VastHttpStatusError ||
        error instanceof VastHttpTimeoutError ||
        isAbort(error)
      ) {
        throw error
      }
      return await this.request(url, timeoutSeconds, 'omit', signal)
    }
  }

  private async request(
    url: string,
    timeoutSeconds: number,
    credentials: RequestCredentials,
    outer: AbortSignal | undefined,
  ): Promise<string> {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, Math.max(1, timeoutSeconds * 1000))
    outer?.addEventListener('abort', abort)
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        mode: 'cors',
        credentials,
        headers: { Accept: 'application/xml, text/xml;q=0.9, */*;q=0.8' },
        redirect: 'follow',
        signal: controller.signal,
      })
      if (!response.ok) throw new VastHttpStatusError(response.status)
      return decode(await response.arrayBuffer())
    } catch (error) {
      // This loader's own timeout aborts the request too, and an `AbortError`
      // is what the resolver reads as the caller leaving. A hop that ran out
      // of time is a 301 the wrappers are owed, so it must not look like one.
      if (timedOut && !outer?.aborted) throw new VastHttpTimeoutError(timeoutSeconds)
      throw error
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', abort)
    }
  }
}

/** A VAST request the server answered with something other than 2xx. */
export class VastHttpStatusError extends Error {
  override readonly name = 'VastHttpStatusError'

  constructor(readonly status: number) {
    super(`VAST request answered ${status}`)
  }
}

interface Outgoing {
  readonly url: string
  readonly recordedMillis: number | null
  readonly retries?: number
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/** A VAST request that got no answer within the per-hop timeout. */
export class VastHttpTimeoutError extends Error {
  override readonly name = 'VastHttpTimeoutError'

  constructor(readonly timeoutSeconds: number) {
    super(`VAST request timed out after ${timeoutSeconds} s`)
  }
}

/**
 * Ad servers are inconsistent about declaring an encoding; UTF-8 first, then
 * Latin-1, which never fails and is better than discarding the ad.
 */
export function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('iso-8859-1').decode(bytes)
  }
}

function isFetchable(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol !== 'http:') return false
    // An https page may not fetch over http — the browser blocks it as mixed
    // content every time, so retrying would only age it out of the queue.
    // VAST 4 asks for https throughout; a tracker that has not moved is lost
    // here as it would be for any https player.
    if (typeof location !== 'undefined' && location.protocol === 'https:') {
      VastLog.warning(`beacon over http blocked as mixed content: ${url}`)
      return false
    }
    return true
  } catch {
    return false
  }
}
