import { VastLog } from './VastLog.js'

/** The slice of the Web Storage API the queue needs — `localStorage` satisfies it. */
export interface VastKeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** One held beacon, with the moment it was first recorded — which is what it ages from. */
export interface VastQueuedBeacon {
  readonly recordedMillis: number
  readonly url: string
  /** Retry flushes it has already failed. Absent on a beacon that has only failed its first send. */
  readonly retries?: number
}

type Entry = VastQueuedBeacon

/**
 * Beacons that did not land, kept until they do.
 *
 * A tracking request is the only record that an ad was shown, and a failed one
 * used to be lost the moment it failed — most often in the case that happens
 * most: a request in flight when the viewer closes the tab. That is not a
 * rounding error in somebody's report; it is the impression that paid for the
 * break.
 *
 * Retrying, including across page loads, is safe by design rather than by hope:
 * a VAST tracking URI carries its own event identity, so a repeat is
 * de-duplicated by the ad server instead of double-counted. `<Impression>` is
 * explicit about at-least-once delivery for exactly this reason — and it is
 * what makes two tabs draining the same queue at once harmless.
 *
 * Limits keep storage from becoming a graveyard and retries from becoming a
 * flood. A beacon older than {@link MAX_AGE_MILLIS} is dropped, because a
 * report about yesterday is worth less to an ad server than a clean count; the
 * queue holds {@link CAPACITY} entries, oldest first out. And a retry is
 * rationed: {@link takeForRetry} hands out at most {@link RETRY_BATCH} beacons,
 * at most once every {@link RETRY_INTERVAL_MILLIS}, and a beacon that has
 * failed {@link MAX_RETRIES} of those is let go. Without that ration a tracker
 * that never answers — an ad blocker makes one of every tracker it knows —
 * had its whole backlog sent again with every new beacon: hundreds of requests
 * per quartile, until the browser refused the page any more connections.
 */
export class VastBeaconQueue {
  /** Older than this and a beacon is dropped rather than sent. */
  static readonly MAX_AGE_MILLIS = 6 * 60 * 60 * 1000

  /** Most beacons kept at once. */
  static readonly CAPACITY = 500

  /** The least time between two retry flushes from one page. */
  static readonly RETRY_INTERVAL_MILLIS = 30_000

  /** The most beacons one retry flush sends. */
  static readonly RETRY_BATCH = 50

  /** Retry flushes a beacon may fail before it is let go. */
  static readonly MAX_RETRIES = 5

  /** Where the shared queue keeps its entries. */
  static readonly STORAGE_KEY = 'kinodaran.vast.pending-beacons'

  private static sharedQueue: VastBeaconQueue | null = null

  /**
   * The page-wide queue, so retries survive the session that queued them — and
   * so a host that builds a transport per break does not build a queue per
   * break, nor a retry ration per break.
   *
   * In `localStorage`, which is per origin and never leaves the device. A queued
   * URL carries whatever the host supplied through the macros — a consent string
   * among them — so it is kept no longer than {@link MAX_AGE_MILLIS}. Where
   * storage is unavailable (a sandboxed iframe, a privacy mode that throws on
   * access) the queue still works for the life of the page, in memory.
   */
  static shared(): VastBeaconQueue {
    if (!VastBeaconQueue.sharedQueue) {
      VastBeaconQueue.sharedQueue = new VastBeaconQueue(defaultStorage(), VastBeaconQueue.STORAGE_KEY)
    }
    return VastBeaconQueue.sharedQueue
  }

  private pending: Entry[] | null = null

  /**
   * Whether storage took the last write. Once a write fails — the quota is
   * full, say — storage no longer holds what this page knows, and memory is
   * the truth until a write succeeds again.
   */
  private writable = true

  /** When this page last handed out a retry batch. */
  private lastRetryMillis = Number.NEGATIVE_INFINITY

  constructor(
    private readonly storage: VastKeyValueStorage | null,
    private readonly key: string = VastBeaconQueue.STORAGE_KEY,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Keeps beacons that failed their first send, so a later flush can try again. */
  enqueue(urls: readonly string[]): void {
    const recorded = this.now()
    this.requeue(urls.map((url) => ({ recordedMillis: recorded, url })))
  }

  /**
   * Puts back beacons that were taken and failed again, keeping when each was
   * first recorded. Re-stamping them would let a tracker that never answers
   * live in storage for ever, carrying whatever consent string its URL holds
   * past the age limit meant to drop it. One that has used up its
   * {@link MAX_RETRIES} is dropped here instead.
   */
  requeue(entries: readonly VastQueuedBeacon[]): void {
    const kept = entries.filter((entry) => (entry.retries ?? 0) < VastBeaconQueue.MAX_RETRIES)
    const dropped = entries.length - kept.length
    if (dropped > 0) VastLog.notice(`gave up on ${dropped} beacon(s) after ${VastBeaconQueue.MAX_RETRIES} retries`)
    if (kept.length === 0) return
    const all = this.trimmed([...this.load(), ...kept])
    this.pending = all
    this.save(all)
    VastLog.notice(`holding ${all.length} beacon(s) for retry`)
  }

  /**
   * The next retry batch — oldest first, at most {@link RETRY_BATCH} — or
   * nothing when this page took one less than {@link RETRY_INTERVAL_MILLIS} ago.
   *
   * Taken rather than copied: whoever takes a batch owns its delivery from that
   * point, and requeues what fails again (with one more retry counted). The
   * rest stays queued for a later batch.
   */
  takeForRetry(): VastQueuedBeacon[] {
    const now = this.now()
    if (now - this.lastRetryMillis < VastBeaconQueue.RETRY_INTERVAL_MILLIS) return []
    const entries = this.trimmed(this.load())
    if (entries.length === 0) return []
    this.lastRetryMillis = now
    const batch = entries.slice(0, VastBeaconQueue.RETRY_BATCH)
    const rest = entries.slice(batch.length)
    this.pending = rest
    this.save(rest)
    return batch
  }

  /**
   * Takes everything worth retrying, and forgets it — unrationed, for a host
   * that sends the backlog itself.
   */
  drain(): string[] {
    return this.drainEntries().map((entry) => entry.url)
  }

  /** {@link drain}, keeping when each beacon was first recorded and how often it was retried, for {@link requeue}. */
  drainEntries(): VastQueuedBeacon[] {
    const entries = this.trimmed(this.load())
    if (entries.length === 0) return []
    this.pending = []
    this.save([])
    return entries
  }

  count(): number {
    return this.trimmed(this.load()).length
  }

  // MARK: - Storage

  /**
   * Read from storage every time rather than cached: another tab may have
   * drained or added to it since. Memory is only the fallback for storage that
   * cannot be read.
   */
  private load(): Entry[] {
    if (this.storage && this.writable) {
      try {
        return parse(this.storage.getItem(this.key))
      } catch {
        // Fall through to memory.
      }
    }
    return this.pending ? [...this.pending] : []
  }

  /**
   * One beacon per line, `recorded<TAB>url` — the format the Android queue
   * writes — with `<TAB>retries` after it once a beacon has failed a retry.
   * URLs have no raw tabs or newlines (they are percent-encoded before a URL is
   * stored), so it needs no escaping. A failed write is not worth interrupting
   * anything for: the beacons are still in memory, and this page will still
   * try to send them.
   */
  private save(entries: readonly Entry[]): void {
    if (!this.storage) return
    try {
      if (entries.length === 0) this.storage.removeItem(this.key)
      else this.storage.setItem(this.key, entries.map(line).join(''))
      this.writable = true
    } catch (error) {
      this.writable = false
      VastLog.notice(`could not hold beacons for retry: ${String(error)}`)
    }
  }

  private trimmed(entries: readonly Entry[]): Entry[] {
    const cutoff = this.now() - VastBeaconQueue.MAX_AGE_MILLIS
    const fresh = entries.filter((entry) => entry.recordedMillis > cutoff)
    return fresh.length <= VastBeaconQueue.CAPACITY ? fresh : fresh.slice(fresh.length - VastBeaconQueue.CAPACITY)
  }
}

function line(entry: Entry): string {
  const retries = entry.retries ?? 0
  return retries > 0 ? `${entry.recordedMillis}\t${entry.url}\t${retries}\n` : `${entry.recordedMillis}\t${entry.url}\n`
}

function parse(text: string | null): Entry[] {
  if (!text) return []
  const entries: Entry[] = []
  for (const raw of text.split('\n')) {
    const tab = raw.indexOf('\t')
    if (tab <= 0) continue
    const recorded = Number(raw.substring(0, tab))
    if (!Number.isFinite(recorded)) continue
    let url = raw.substring(tab + 1)
    let retries = 0
    const last = url.lastIndexOf('\t')
    if (last >= 0) {
      const count = Number(url.substring(last + 1))
      if (Number.isInteger(count) && count >= 0) {
        retries = count
        url = url.substring(0, last)
      }
    }
    entries.push(retries > 0 ? { recordedMillis: recorded, url, retries } : { recordedMillis: recorded, url })
  }
  return entries
}

/** `localStorage`, or `null` where touching it throws — which some privacy modes do. */
function defaultStorage(): VastKeyValueStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const probe = '__vast_probe__'
    localStorage.setItem(probe, probe)
    localStorage.removeItem(probe)
    return localStorage
  } catch {
    return null
  }
}
