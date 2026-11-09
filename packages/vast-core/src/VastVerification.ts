/**
 * One `<Verification>` from `<AdVerifications>` (§3.16): a measurement vendor
 * asking to observe this ad.
 *
 * The SDK parses these and hands them over; it never executes them. Running
 * verification code means the IAB Open Measurement SDK, which is licensed
 * separately and lives outside this library — so what belongs here is the
 * description of what was asked for, and enough detail to report honestly when
 * nothing runs it.
 */
export interface VastVerification {
  /** `<Verification vendor>`. Absent on responses that predate the attribute. */
  readonly vendor: string | null
  readonly resources: readonly VastVerificationResource[]
  /** `<VerificationParameters>` — opaque to everyone but the vendor. */
  readonly parameters: string | null
  /**
   * `<Tracking event="verificationNotExecuted">`. Owed when the vendor's code
   * does not run, so the vendor can tell "unmeasured" from "unserved".
   */
  readonly notExecutedTrackers: readonly string[]
}

/**
 * `javaScript` — a `<JavaScriptResource>`.
 * `executable` — native vendor code (`<ExecutableResource>`). Nothing in this
 * SDK can run one; it is modelled so the reason reported back is the true one.
 */
export type VastVerificationResourceKind = 'javaScript' | 'executable'

/** One `<JavaScriptResource>` or `<ExecutableResource>`. */
export interface VastVerificationResource {
  readonly kind: VastVerificationResourceKind
  readonly url: string
  /** `omid` for Open Measurement. Other values exist and are not ours. */
  readonly apiFramework: string | null
  /**
   * `<JavaScriptResource browserOptional>`: whether the script can run
   * outside a browser context. Defaults to false per §3.16.
   */
  readonly browserOptional: boolean
  /** `<ExecutableResource type>`, e.g. a platform identifier. */
  readonly type: string | null
}

/**
 * Why a vendor's code did not run, as the values §3.16 defines for the
 * `verificationNotExecuted` tracker's `[REASON]` macro.
 */
export const VastNotExecutedReason = {
  /**
   * No resource this host could ever execute — executable-only, or a
   * JavaScript resource for a framework other than OMID.
   */
  RESOURCE_NOT_SUPPORTED: 1,
  /**
   * A usable resource that failed to load or timed out. Only whoever tried
   * to load it knows this, so the SDK never reports it on its own.
   */
  RESOURCE_LOAD_ERROR: 2,
  /**
   * A usable resource that nothing was asked to run — no measurement
   * integration is configured.
   */
  NOT_EXECUTED: 3,
} as const

export type VastNotExecutedReason = (typeof VastNotExecutedReason)[keyof typeof VastNotExecutedReason]

/** Ad servers are inconsistent about the case of `omid`. */
export function isOmidResource(resource: VastVerificationResource): boolean {
  return resource.apiFramework?.toLowerCase() === 'omid'
}

/**
 * The resource an Open Measurement integration can actually use.
 *
 * `null` means nothing here is executable by an OMID host — an
 * `<ExecutableResource>`, or a JavaScript resource for some other framework.
 * That distinction is what separates `RESOURCE_NOT_SUPPORTED` from
 * `NOT_EXECUTED` when reporting.
 */
export function omidResource(verification: VastVerification): VastVerificationResource | null {
  return verification.resources.find((r) => r.kind === 'javaScript' && isOmidResource(r)) ?? null
}

export function createVerification(
  init: Partial<VastVerification> & Pick<VastVerification, 'resources'>,
): VastVerification {
  return {
    vendor: init.vendor ?? null,
    resources: init.resources,
    parameters: init.parameters ?? null,
    notExecutedTrackers: init.notExecutedTrackers ?? [],
  }
}

export function createVerificationResource(
  init: Partial<VastVerificationResource> & Pick<VastVerificationResource, 'kind' | 'url'>,
): VastVerificationResource {
  return {
    kind: init.kind,
    url: init.url,
    apiFramework: init.apiFramework ?? null,
    browserOptional: init.browserOptional ?? false,
    type: init.type ?? null,
  }
}
