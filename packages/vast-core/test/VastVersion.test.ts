import { describe, expect, it } from 'vitest'
import { VastVersion } from '../src/VastVersion.js'

describe('VastVersion', () => {
  it('versionIsSemantic', () => {
    expect(/^\d+\.\d+\.\d+$/.test(VastVersion.CURRENT), VastVersion.CURRENT).toBe(true)
  })
})
