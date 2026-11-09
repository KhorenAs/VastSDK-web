import type { VastAd } from './VastAd.js'
import type { VastBeacon } from './VastBeacon.js'
import { VastError, VastException, vastErrorName } from './VastError.js'
import { VastParser } from './VastParser.js'
import { VastWrapperChain, type VastResourceLoader, type VastWrapperChainStep } from './VastWrapperChain.js'

/** Ads plus the error URIs owed if playback later fails. */
export interface VastResolution {
  readonly ads: readonly VastAd[]
  readonly chain: VastWrapperChain
}

/**
 * Raised when the chain ends without a playable ad. `beacons` are the
 * `<Error>` requests owed to every Wrapper that was traversed.
 */
export class VastTagResolverFailure extends Error {
  override readonly name = 'VastTagResolverFailure'

  constructor(
    readonly error: VastError,
    readonly beacons: readonly VastBeacon[],
    options?: { cause?: unknown },
  ) {
    super(`VAST resolution failed with ${error} ${vastErrorName(error)}`)
    if (options && 'cause' in options) {
      Object.defineProperty(this, 'cause', { value: options.cause, configurable: true, writable: true })
    }
  }
}

/**
 * Fetches a tag and follows its Wrapper chain to the InLine ads behind it.
 *
 * The only impure part is asking the loader for XML; every decision — when to
 * stop, which error code to report, what to accumulate — belongs to
 * {@link VastWrapperChain} and is tested without IO.
 */
export class VastTagResolver {
  private readonly parser = new VastParser()

  constructor(
    private readonly loader: VastResourceLoader,
    private readonly maxDepth = 5,
    /** Per hop. A session that wants a bound on the whole chain imposes it around this call. */
    private readonly timeoutSeconds = 5,
  ) {}

  /** Resolves a tag URL, following Wrappers until an InLine response. */
  resolveTag(url: string, signal?: AbortSignal): Promise<VastResolution> {
    return this.follow(url, new VastWrapperChain(this.maxDepth), signal)
  }

  /**
   * Resolves a document already in hand. Wrappers inside it are still followed,
   * so a caller holding XML gets the same behaviour as {@link resolveTag}.
   */
  async resolveXml(xml: string, baseUrl: string | null = null, signal?: AbortSignal): Promise<VastResolution> {
    const chain = new VastWrapperChain(this.maxDepth)
    const step = this.step(xml, baseUrl, chain)
    switch (step.type) {
      case 'resolved':
        return { ads: step.ads, chain }
      case 'failed':
        throw new VastTagResolverFailure(step.error, chain.errorBeacons(step.error))
      // The chain carries on rather than starting again. Handing the tail a
      // fresh one would drop this document's own `<Impression>` and `<Error>`
      // URIs, restart the depth count — making the effective limit twice
      // `maxDepth` — and lose its `allowMultipleAds` constraint.
      case 'follow':
        return this.follow(step.url, chain, signal)
    }
  }

  /** Walks the redirect chain from `url`, carrying what has been collected. */
  private async follow(url: string, chain: VastWrapperChain, signal?: AbortSignal): Promise<VastResolution> {
    let next = url
    for (;;) {
      throwIfAborted(signal)
      let xml: string
      try {
        xml = await this.loader.loadVast(next, this.timeoutSeconds, signal)
      } catch (cause) {
        // Cancellation is the caller leaving, not the redirect failing:
        // nothing is reported for a break nobody is waiting for.
        if (signal?.aborted || isAbort(cause)) throw abortError(signal, cause)
        // A dead or slow redirect is a 301, and the wrappers already
        // traversed still expect to hear about it.
        throw new VastTagResolverFailure(VastError.WRAPPER_TIMEOUT, chain.errorBeacons(VastError.WRAPPER_TIMEOUT), {
          cause,
        })
      }
      throwIfAborted(signal)

      const step = this.step(xml, next, chain)
      switch (step.type) {
        case 'resolved':
          return { ads: step.ads, chain }
        case 'follow':
          next = step.url
          break
        case 'failed':
          throw new VastTagResolverFailure(step.error, chain.errorBeacons(step.error))
      }
    }
  }

  private step(xml: string, baseUrl: string | null, chain: VastWrapperChain): VastWrapperChainStep {
    let document
    try {
      document = this.parser.parse(xml)
    } catch (failure) {
      if (!(failure instanceof VastException)) throw failure
      throw new VastTagResolverFailure(failure.error, chain.errorBeacons(failure.error), { cause: failure })
    }
    return chain.accept(document, baseUrl)
  }
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

/** The abort, as the platform spells it: a `DOMException` named `AbortError` where one exists. */
function abortError(signal: AbortSignal | undefined, cause?: unknown): Error {
  if (isAbort(cause)) return cause as Error
  const reason = (signal as { reason?: unknown } | undefined)?.reason
  if (isAbort(reason)) return reason as Error
  if (typeof DOMException === 'function') return new DOMException('resolution cancelled', 'AbortError')
  const error = new Error('resolution cancelled')
  error.name = 'AbortError'
  return error
}
