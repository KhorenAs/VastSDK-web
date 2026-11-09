/**
 * The SDK's console voice, one prefix so a host can filter it.
 *
 * Quiet by default where the platform is quiet: `notice` is a debug line, and
 * only what a host must act on — a skip control nobody can reach, a click path
 * that does not exist — is raised as a warning.
 */
export const VastLog = {
  /** Set to `false` to silence the SDK entirely, warnings included. */
  enabled: true,

  notice(message: string): void {
    if (VastLog.enabled && typeof console !== 'undefined') console.debug(`[VastSDK] ${message}`)
  },

  warning(message: string): void {
    if (VastLog.enabled && typeof console !== 'undefined') console.warn(`[VastSDK] ${message}`)
  },
}
