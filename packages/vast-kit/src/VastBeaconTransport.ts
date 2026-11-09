import type { VastBeacon } from '@kinodaran/vast-core'

/**
 * Sends the beacons the engine produced. Fire-and-forget: a tracking failure
 * must never interrupt playback, so an implementation reports nothing back and
 * rejects with nothing.
 */
export interface VastBeaconTransport {
  fire(beacons: readonly VastBeacon[]): Promise<void>
}
