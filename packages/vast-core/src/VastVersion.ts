/**
 * This SDK's own version.
 *
 * Hard-coded rather than read from package.json at build time: a version that
 * reads as "unknown" in a production bundle is worse than one that has to be
 * edited at release time. It reaches ad servers through `[CLIENTUA]`, which is
 * how an exchange tells one player from another when a creative misbehaves.
 */
export const VastVersion = {
  CURRENT: '0.1.0',
} as const
