import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VastBeacon } from '@kinodaran/vast-core'
import { VastBeaconQueue, type VastKeyValueStorage } from '../src/VastBeaconQueue.js'
import { decode, VastFetchLoader, VastFetchTransport, VastHttpStatusError } from '../src/VastHttp.js'
import { VastLog } from '../src/VastLog.js'

/**
 * A tracking request is the only record that an ad was shown. These check that
 * one is not lost when it fails, within what a browser can know: beacons go out
 * `no-cors`, so only a request that got no answer at all can be told apart.
 */

VastLog.enabled = false

const KEY = VastBeaconQueue.STORAGE_KEY

function url(path: string): string {
  return `https://ads.test/${path}`
}

function beacon(target: string): VastBeacon {
  return { kind: { type: 'impression' }, url: target, adId: 'a1' }
}

/** `localStorage`, in memory, that can be made to throw on read or on write. */
class MemoryStorage implements VastKeyValueStorage {
  readonly items = new Map<string, string>()
  failReads = false
  failWrites = false

  getItem(key: string): string | null {
    if (this.failReads) throw new DOMException('denied', 'SecurityError')
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError')
    this.items.set(key, value)
  }

  removeItem(key: string): void {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError')
    this.items.delete(key)
  }
}

type Outcome = 'answer' | 'network' | 'hang'

interface FetchCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

/**
 * `fetch`, answering by script. `network` rejects as a dead host does; `hang`
 * never answers until its signal aborts, as a real request that timed out.
 */
function scriptedFetch(script: (url: string, attempt: number) => Outcome | Response) {
  const calls: FetchCall[] = []
  const attempts = new Map<string, number>()
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input)
    calls.push({ url: target, init })
    const attempt = (attempts.get(target) ?? 0) + 1
    attempts.set(target, attempt)
    const outcome = script(target, attempt)
    if (outcome instanceof Response) return Promise.resolve(outcome)
    switch (outcome) {
      case 'answer':
        return Promise.resolve(new Response(null, { status: 204 }))
      case 'network':
        return Promise.reject(new TypeError('Failed to fetch'))
      case 'hang':
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    }
  }) as typeof fetch
  return { impl, calls }
}

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// MARK: - The queue

describe('VastBeaconQueue', () => {
  it('keeps an undelivered beacon', () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    queue.enqueue([url('impression')])
    expect(queue.count()).toBe(1)
  })

  /** Taken rather than copied. Draining and keeping would send every beacon again on every flush. */
  it('empties itself and its storage when drained', () => {
    const storage = new MemoryStorage()
    const queue = new VastBeaconQueue(storage)
    queue.enqueue([url('a'), url('b')])

    expect(queue.drain()).toEqual([url('a'), url('b')])
    expect(queue.count(), 'a drained beacon would be sent twice').toBe(0)
    expect(storage.items.has(KEY)).toBe(false)
    expect(queue.drain()).toEqual([])
  })

  it('writes one `recorded<TAB>url` line per beacon — the format the Android queue writes', () => {
    const storage = new MemoryStorage()
    const queue = new VastBeaconQueue(storage, KEY, () => 1_700_000_000_000)
    queue.enqueue([url('a'), url('b?x=1&y=%20')])

    expect(storage.items.get(KEY)).toBe(`1700000000000\t${url('a')}\n1700000000000\t${url('b?x=1&y=%20')}\n`)
  })

  it('adds a retry count to the line once a beacon has failed a retry, and reads both shapes back', () => {
    const storage = new MemoryStorage()
    const queue = new VastBeaconQueue(storage, KEY, () => 1700000000000)
    queue.requeue([{ recordedMillis: 1700000000000, url: url('a'), retries: 2 }])
    queue.enqueue([url('b')])

    expect(storage.items.get(KEY)).toBe(`1700000000000\t${url('a')}\t2\n1700000000000\t${url('b')}\n`)
    expect(queue.drainEntries()).toEqual([
      { recordedMillis: 1700000000000, url: url('a'), retries: 2 },
      { recordedMillis: 1700000000000, url: url('b') },
    ])
  })

  it('reads that format back, skipping lines it cannot make sense of', () => {
    const now = 1_700_000_000_000
    const storage = new MemoryStorage()
    storage.items.set(
      KEY,
      [`${now - 2000}\t${url('first')}`, 'garbage', `\t${url('no-time')}`, `abc\t${url('nan')}`, '', `${now - 1000}\t${url('last')}`].join('\n'),
    )
    const queue = new VastBeaconQueue(storage, KEY, () => now)

    expect(queue.drain()).toEqual([url('first'), url('last')])
  })

  /** What another tab queued, or an earlier page, is this tab's to send too. */
  it('shares its storage with every queue on it', () => {
    const storage = new MemoryStorage()
    new VastBeaconQueue(storage).enqueue([url('impression')])

    expect(new VastBeaconQueue(storage).drain()).toEqual([url('impression')])
  })

  it('is capped, oldest out first', () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    queue.enqueue(Array.from({ length: VastBeaconQueue.CAPACITY + 20 }, (_, i) => url(`beacon${i}`)))

    const drained = queue.drain()
    expect(drained).toHaveLength(VastBeaconQueue.CAPACITY)
    expect(drained[0]).toBe(url('beacon20'))
    expect(drained[drained.length - 1], 'the newest beacons are the ones worth keeping').toBe(
      url(`beacon${VastBeaconQueue.CAPACITY + 19}`),
    )
  })

  /** A report about yesterday is worth less to an ad server than a clean count — and the URL may carry consent. */
  it('drops a beacon once it is MAX_AGE old', () => {
    let now = 1_000_000_000
    const queue = new VastBeaconQueue(new MemoryStorage(), KEY, () => now)
    queue.enqueue([url('old')])
    now += VastBeaconQueue.MAX_AGE_MILLIS - 1
    queue.enqueue([url('new')])
    expect(queue.count()).toBe(2)

    now += 1
    expect(queue.drain()).toEqual([url('new')])
  })

  it('falls back to memory when storage throws', () => {
    const storage = new MemoryStorage()
    storage.failReads = true
    storage.failWrites = true
    const queue = new VastBeaconQueue(storage)

    queue.enqueue([url('a')])
    expect(queue.count()).toBe(1)
    expect(queue.drain()).toEqual([url('a')])
    expect(queue.count()).toBe(0)
  })

  it('works in memory with no storage at all', () => {
    const queue = new VastBeaconQueue(null)
    queue.enqueue([url('a')])
    expect(queue.drain()).toEqual([url('a')])
  })

  it('keeps a beacon whose write to storage failed', () => {
    const storage = new MemoryStorage()
    storage.failWrites = true
    const queue = new VastBeaconQueue(storage)

    queue.enqueue([url('impression')])

    expect(queue.count(), 'the impression that paid for the break was dropped').toBe(1)
  })

  it('is one queue for the whole page', () => {
    expect(VastBeaconQueue.shared()).toBe(VastBeaconQueue.shared())
  })
})

// MARK: - The transport

describe('VastFetchTransport', () => {
  it('sends a no-cors, keepalive, credentialed GET that bypasses the cache', async () => {
    const fetch = scriptedFetch(() => 'answer')
    await new VastFetchTransport(new VastBeaconQueue(null), 2, 5000, fetch.impl).fire([beacon(url('impression'))])

    expect(fetch.calls).toHaveLength(1)
    const init = fetch.calls[0]!.init!
    expect(fetch.calls[0]!.url).toBe(url('impression'))
    expect(init).toMatchObject({
      method: 'GET',
      mode: 'no-cors',
      credentials: 'include',
      cache: 'no-store',
      keepalive: true,
      redirect: 'follow',
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  /** An opaque answer says the request reached a server; which status it got is not the page's to know. */
  it('takes any HTTP answer as final: no retry, nothing queued', async () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    const fetch = scriptedFetch(() => new Response(null, { status: 500 }))
    await new VastFetchTransport(queue, 2, 5000, fetch.impl).fire([beacon(url('impression'))])

    expect(fetch.calls).toHaveLength(1)
    expect(queue.count()).toBe(0)
  })

  it('retries a request that got no answer, then queues it', async () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    const fetch = scriptedFetch(() => 'network')
    await new VastFetchTransport(queue, 2, 5000, fetch.impl).fire([beacon(url('impression'))])

    expect(fetch.calls.map((call) => call.url)).toEqual([url('impression'), url('impression')])
    expect(queue.drain()).toEqual([url('impression')])
  })

  it('does not queue a beacon whose retry landed', async () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    const fetch = scriptedFetch((_, attempt) => (attempt === 1 ? 'network' : 'answer'))
    await new VastFetchTransport(queue, 2, 5000, fetch.impl).fire([beacon(url('impression'))])

    expect(fetch.calls).toHaveLength(2)
    expect(queue.count()).toBe(0)
  })

  it('always makes at least one attempt', async () => {
    const fetch = scriptedFetch(() => 'network')
    await new VastFetchTransport(new VastBeaconQueue(null), 0, 5000, fetch.impl).fire([beacon(url('impression'))])
    expect(fetch.calls).toHaveLength(1)
  })

  it('abandons a request that outlives its timeout, as a request that got no answer', async () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    const fetch = scriptedFetch(() => 'hang')
    await new VastFetchTransport(queue, 2, 5, fetch.impl).fire([beacon(url('impression'))])

    expect(fetch.calls).toHaveLength(2)
    expect(fetch.calls.every((call) => call.init?.signal?.aborted)).toBe(true)
    expect(queue.count()).toBe(1)
  })

  /** Retries cost no timer of their own: they go out when the network is evidently working. */
  it('sends what is queued along with the next beacon', async () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    const failing = scriptedFetch(() => 'network')
    await new VastFetchTransport(queue, 1, 5000, failing.impl).fire([beacon(url('impression'))])
    expect(queue.count()).toBe(1)

    const working = scriptedFetch(() => 'answer')
    await new VastFetchTransport(queue, 1, 5000, working.impl).fire([beacon(url('start'))])

    expect(working.calls.map((call) => call.url)).toEqual([url('impression'), url('start')])
    expect(queue.count()).toBe(0)
  })

  it('flushes the queue with no new beacon to carry it, and asks for nothing when it is empty', async () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    queue.enqueue([url('left-over')])
    const fetch = scriptedFetch(() => 'answer')
    const transport = new VastFetchTransport(queue, 1, 5000, fetch.impl)

    await transport.flushPending()
    expect(fetch.calls.map((call) => call.url)).toEqual([url('left-over')])
    await transport.flushPending()
    expect(fetch.calls).toHaveLength(1)
  })

  it('sends beacons concurrently, so one slow tracker holds up no other', async () => {
    const fetch = scriptedFetch((target) => (target === url('slow') ? 'hang' : 'answer'))
    const fired = new VastFetchTransport(new VastBeaconQueue(null), 1, 20, fetch.impl).fire([
      beacon(url('slow')),
      beacon(url('fast')),
    ])

    expect(fetch.calls.map((call) => call.url), 'both requests are out before either answers').toEqual([url('slow'), url('fast')])
    await fired
  })

  it.each(['not a url', 'javascript:alert(1)', 'data:text/plain,hello', 'ftp://ads.test/x', ''])(
    'drops %j, which nobody could ever fetch, rather than carrying it from flush to flush',
    async (target) => {
      const queue = new VastBeaconQueue(new MemoryStorage())
      const fetch = scriptedFetch(() => 'network')
      await new VastFetchTransport(queue, 2, 5000, fetch.impl).fire([beacon(target)])

      expect(fetch.calls).toEqual([])
      expect(queue.count()).toBe(0)
    },
  )

  it('drops an http beacon on an https page, where the browser blocks it as mixed content', async () => {
    vi.stubGlobal('location', { protocol: 'https:', href: 'https://player.test/' })
    const queue = new VastBeaconQueue(new MemoryStorage())
    const fetch = scriptedFetch(() => 'network')
    await new VastFetchTransport(queue, 2, 5000, fetch.impl).fire([
      beacon('http://tracker.test/impression'),
      beacon('https://tracker.test/start'),
    ])

    expect(fetch.calls.map((call) => call.url)).toEqual(['https://tracker.test/start', 'https://tracker.test/start'])
    expect(queue.drain()).toEqual(['https://tracker.test/start'])
  })

  it('sends an http beacon from an http page', async () => {
    vi.stubGlobal('location', { protocol: 'http:', href: 'http://player.test/' })
    const fetch = scriptedFetch(() => 'answer')
    await new VastFetchTransport(new VastBeaconQueue(null), 2, 5000, fetch.impl).fire([beacon('http://tracker.test/impression')])

    expect(fetch.calls.map((call) => call.url)).toEqual(['http://tracker.test/impression'])
  })

  it('never rejects, and without a queue simply lets a failure go', async () => {
    const fetch = scriptedFetch(() => 'network')
    await expect(new VastFetchTransport(null, 1, 5000, fetch.impl).fire([beacon(url('impression'))])).resolves.toBeUndefined()
  })

  // MARK: The retry ration

  /**
   * Found by hand in a browser: with a tracker that never answers, every new
   * beacon re-sent the whole backlog, twice, so one ad produced dozens of
   * requests per tracker and a long session ran the page out of connections
   * (net::ERR_INSUFFICIENT_RESOURCES). An ad blocker makes a tracker like that
   * of every tracker it knows.
   */
  it('re-sends the backlog at most once per interval however many beacons fire — not with every one', async () => {
    let now = 1_000_000_000
    const queue = new VastBeaconQueue(new MemoryStorage(), KEY, () => now)
    const fetch = scriptedFetch(() => 'network')
    const transport = new VastFetchTransport(queue, 2, 5000, fetch.impl)

    const events = ['impression', 'start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete']
    for (const event of events) {
      await transport.fire([beacon(url(event))])
      now += 1000
    }

    const sends = (target: string) => fetch.calls.filter((call) => call.url === target).length
    expect(sends(url('impression')), 'its own two attempts, then one retry within the interval').toBe(3)
    expect(fetch.calls.length, 'six beacons, two attempts each, and one retry batch').toBe(13)
    expect(queue.count()).toBe(6)
  })

  it('retries again once the interval has passed', async () => {
    let now = 1_000_000_000
    const queue = new VastBeaconQueue(new MemoryStorage(), KEY, () => now)
    queue.enqueue([url('impression')])
    const fetch = scriptedFetch(() => 'network')
    const transport = new VastFetchTransport(queue, 2, 5000, fetch.impl)

    await transport.flushPending()
    await transport.flushPending()
    expect(fetch.calls, 'once per interval').toHaveLength(1)

    now += VastBeaconQueue.RETRY_INTERVAL_MILLIS
    await transport.flushPending()
    expect(fetch.calls).toHaveLength(2)
  })

  it('gives a queued beacon one attempt per batch, where a first send gets two', async () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    queue.enqueue([url('old')])
    const fetch = scriptedFetch(() => 'network')

    await new VastFetchTransport(queue, 2, 5000, fetch.impl).fire([beacon(url('new'))])

    expect(fetch.calls.map((call) => call.url).sort()).toEqual([url('new'), url('new'), url('old')])
  })

  it('sends at most RETRY_BATCH queued beacons in one flush, oldest first, and keeps the rest', async () => {
    let now = 1_000_000_000
    const queue = new VastBeaconQueue(new MemoryStorage(), KEY, () => now)
    for (let i = 0; i < VastBeaconQueue.RETRY_BATCH + 10; i++) {
      queue.enqueue([url(`b${i}`)])
      now += 1
    }
    const fetch = scriptedFetch(() => 'answer')

    await new VastFetchTransport(queue, 1, 5000, fetch.impl).flushPending()

    expect(fetch.calls).toHaveLength(VastBeaconQueue.RETRY_BATCH)
    expect(fetch.calls[0]!.url).toBe(url('b0'))
    expect(queue.count()).toBe(10)
  })

  it('lets go of a beacon after MAX_RETRIES failed batches, well before it would age out', async () => {
    let now = 1_000_000_000
    const queue = new VastBeaconQueue(new MemoryStorage(), KEY, () => now)
    queue.enqueue([url('blocked')])
    const fetch = scriptedFetch(() => 'network')
    const transport = new VastFetchTransport(queue, 2, 5000, fetch.impl)

    for (let i = 0; i < VastBeaconQueue.MAX_RETRIES + 2; i++) {
      await transport.flushPending()
      now += VastBeaconQueue.RETRY_INTERVAL_MILLIS
    }

    expect(fetch.calls).toHaveLength(VastBeaconQueue.MAX_RETRIES)
    expect(queue.count()).toBe(0)
  })

  it('shares one ration across every transport on the page, as one session per break would build', async () => {
    const queue = new VastBeaconQueue(new MemoryStorage())
    queue.enqueue([url('old')])
    const fetch = scriptedFetch(() => 'network')

    for (let session = 0; session < 5; session++) await new VastFetchTransport(queue, 2, 5000, fetch.impl).flushPending()

    expect(fetch.calls).toHaveLength(1)
  })

  it('lets a beacon that keeps failing age out from when it was first recorded', async () => {
    let now = 1_000_000_000
    const queue = new VastBeaconQueue(new MemoryStorage(), KEY, () => now)
    const fetch = scriptedFetch((target) => (target === url('blocked') ? 'network' : 'answer'))
    const transport = new VastFetchTransport(queue, 1, 5000, fetch.impl)

    await transport.fire([beacon(url('blocked'))])
    now += VastBeaconQueue.MAX_AGE_MILLIS - 60_000
    await transport.fire([beacon(url('start'))])
    now += 120_000

    expect(queue.drain(), 'a URL that may carry a consent string outlived MAX_AGE').toEqual([])
  })
})

// MARK: - The loader

describe('VastFetchLoader', () => {
  const TAG = 'https://ads.test/tag.xml'

  it('reads a tag with a credentialed CORS GET that asks for XML', async () => {
    const fetch = scriptedFetch(() => new Response('<VAST/>', { status: 200 }))
    const xml = await new VastFetchLoader('include', fetch.impl).loadVast(TAG, 5)

    expect(xml).toBe('<VAST/>')
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]!.init).toMatchObject({ method: 'GET', mode: 'cors', credentials: 'include', redirect: 'follow' })
    expect((fetch.calls[0]!.init!.headers as Record<string, string>).Accept).toContain('application/xml')
  })

  /** An ad server answering `Access-Control-Allow-Origin: *` fails a credentialed read at the network level. */
  it('retries once without credentials when the request got no answer', async () => {
    const fetch = scriptedFetch((_, attempt) => (attempt === 1 ? 'network' : new Response('<VAST/>', { status: 200 })))
    const xml = await new VastFetchLoader('include', fetch.impl).loadVast(TAG, 5)

    expect(xml).toBe('<VAST/>')
    expect(fetch.calls.map((call) => call.init?.credentials)).toEqual(['include', 'omit'])
  })

  it('fails after the second try for a server that is simply down', async () => {
    const fetch = scriptedFetch(() => 'network')
    await expect(new VastFetchLoader('include', fetch.impl).loadVast(TAG, 5)).rejects.toBeInstanceOf(TypeError)
    expect(fetch.calls).toHaveLength(2)
  })

  it('does not retry a non-2xx answer, which throws VastHttpStatusError', async () => {
    const fetch = scriptedFetch(() => new Response('gone', { status: 404 }))
    const failure = await new VastFetchLoader('include', fetch.impl).loadVast(TAG, 5).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(VastHttpStatusError)
    expect((failure as VastHttpStatusError).status).toBe(404)
    expect(fetch.calls, 'the server answered; asking again without cookies changes nothing').toHaveLength(1)
  })

  it.each(['omit', 'same-origin'] as const)('does not retry when the host chose credentials %s', async (credentials) => {
    const fetch = scriptedFetch(() => 'network')
    await expect(new VastFetchLoader(credentials, fetch.impl).loadVast(TAG, 5)).rejects.toBeInstanceOf(TypeError)
    expect(fetch.calls.map((call) => call.init?.credentials)).toEqual([credentials])
  })

  it('honours the abort signal, and does not retry a request its caller left', async () => {
    const fetch = scriptedFetch(() => 'hang')
    const controller = new AbortController()
    const loading = new VastFetchLoader('include', fetch.impl).loadVast(TAG, 5, controller.signal)
    controller.abort()

    await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]!.init!.signal!.aborted).toBe(true)
  })

  /**
   * As a timeout, not an `AbortError`: the resolver reads an abort as the
   * caller leaving and reports nothing, where a hop that ran out of time is a
   * 301 every wrapper above it is owed.
   */
  it('gives up on a hop after timeoutSeconds, as a timeout rather than a cancellation', async () => {
    const fetch = scriptedFetch(() => 'hang')
    await expect(new VastFetchLoader('include', fetch.impl).loadVast(TAG, 0.01)).rejects.toMatchObject({
      name: 'VastHttpTimeoutError',
    })
    expect(fetch.calls[0]!.init!.signal!.aborted).toBe(true)
  })

  it('reports a cancellation by the caller as the abort it is', async () => {
    const fetch = scriptedFetch(() => 'hang')
    const controller = new AbortController()
    const pending = new VastFetchLoader('include', fetch.impl).loadVast(TAG, 5, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch.calls).toHaveLength(1)
  })

  it('does not retry a hop that timed out, which is no CORS refusal', async () => {
    const fetch = scriptedFetch(() => 'hang')
    await new VastFetchLoader('include', fetch.impl).loadVast(TAG, 0.01).catch(() => undefined)
    expect(fetch.calls).toHaveLength(1)
  })

  it('reads UTF-8, and Latin-1 when the bytes are not UTF-8, rather than discarding the ad', async () => {
    const latin1 = bytes(0x3c, 0xe9, 0x3e)
    const utf8 = new TextEncoder().encode('<é>')
    expect(decode(latin1.buffer as ArrayBuffer)).toBe('<é>')
    expect(decode(utf8.buffer as ArrayBuffer)).toBe('<é>')

    const fetch = scriptedFetch(() => new Response(latin1, { status: 200 }))
    expect(await new VastFetchLoader('include', fetch.impl).loadVast(TAG, 5)).toBe('<é>')
  })
})
