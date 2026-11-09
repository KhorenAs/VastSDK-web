/**
 * One observation of the ad playhead.
 *
 * The tracking engine never asks a player for the time — time is pushed in.
 * That makes every rule (quartiles, seek rejection, asset-swap detection) a pure
 * function of two consecutive ticks, and therefore unit-testable without a
 * player, a media file, or real elapsed time.
 */
export interface VastTick {
  /** Playhead inside the ad creative, in seconds. */
  readonly adTime: number
  /** Duration reported by the player; falls back to `<Duration>` when unknown. */
  readonly duration: number | null
  /** `0` while paused/stalled. Quartiles only count at normal speed (§3.14.1). */
  readonly rate: number
  /** Monotonic wall clock in seconds, used to tell natural playback from a seek. */
  readonly wallClock: number
  /** `false` once the host swapped the player's source out from under the ad. Default `true`. */
  readonly itemIsOurs?: boolean
  /** Default `false`. */
  readonly isMuted?: boolean
}
