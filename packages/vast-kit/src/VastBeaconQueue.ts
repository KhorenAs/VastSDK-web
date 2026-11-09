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
 * Two limits keep storage from becoming a graveyard. A beacon older than
 * {@link MAX_AGE_MILLIS} is dropped, because a report about yesterday is worth
 * less to an ad server than a clean count; and the queue holds {@link CAPACITY}
 * entries, oldest first out, so a device that spends a week offline does not
 * accumulate a megabyte of URLs it will never send.
 */
export class VastBeaconQueue {
  /** Older than this and a beacon is dropped rather than sent. */
  static readonly MAX_AGE_MILLIS = 6 * 60 * 60 * 1000

  /** Most beacons kept at once. */
  static readonly CAPACITY = 500

  /** Where the shared queue keeps its entries. */
  static readonly STORAGE_KEY = 'kinodaran.vast.pending-beacons'

  private static sharedQueue: VastBeaconQueue | null = null

  /**
   * The page-wide queue, so retries survive the session that queued them — and
   * so a host that builds a transport per break does not build a queue per break.
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

  constructor(
    private readonly storage: VastKeyValueStorage | null,
    private readonly key: string = VastBeaconQueue.STORAGE_KEY,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Keeps beacons that failed, so the next flush can try again. */
  enqueue(urls: readonly string[]): void {
    const recorded = this.now()
    this.requeue(urls.map((url) => ({ recordedMillis: recorded, url })))
  }

  /**
   * Puts back beacons that were drained and failed again, keeping when each
   * was first recorded. Re-stamping them would let a tracker that never
   * answers — an ad blocker sees to that — live in storage for ever, carrying
   * whatever consent string its URL holds past the age limit meant to drop it.
   */
  requeue(entries: readonly VastQueuedBeacon[]): void {
    if (entries.length === 0) return
    const kept = this.trimmed([...this.load(), ...entries])
    this.pending = kept
    this.save(kept)
    VastLog.notice(`holding ${kept.length} beacon(s) for retry`)
  }

  /**
   * Takes everything worth retrying, and forgets it.
   *
   * Taken rather than copied: whoever drains the queue owns delivery from that
   * point, and re-queues what fails again. Holding on as well would send every
   * beacon twice on every flush for as long as one of them kept failing.
   */
  drain(): string[] {
    return this.drainEntries().map((entry) => entry.url)
  }

  /** {@link drain}, keeping when each beacon was first recorded, for {@link requeue}. */
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
   * writes. URLs have no raw tabs or newlines (they are percent-encoded before
   * a URL is stored), so it needs no escaping. A failed write is not worth
   * interrupting anything for: the beacons are still in memory, and this page
   * will still try to send them.
   */
  private save(entries: readonly Entry[]): void {
    if (!this.storage) return
    try {
      if (entries.length === 0) this.storage.removeItem(this.key)
      else this.storage.setItem(this.key, entries.map((e) => `${e.recordedMillis}\t${e.url}\n`).join(''))
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

function parse(text: string | null): Entry[] {
  if (!text) return []
  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const recorded = Number(line.substring(0, tab))
    if (Number.isFinite(recorded)) entries.push({ recordedMillis: recorded, url: line.substring(tab + 1) })
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
