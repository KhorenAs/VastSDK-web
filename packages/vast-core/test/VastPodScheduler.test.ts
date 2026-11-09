import { describe, expect, it } from 'vitest'
import { createAd, createLinear, type VastAd } from '../src/VastAd.js'
import { VastPodScheduler } from '../src/VastPodScheduler.js'

function ad(id: string, sequence: number | null = null): VastAd {
  return createAd({ id, sequence, linear: createLinear({ duration: 10 }) })
}

function drain(scheduler: VastPodScheduler): string[] {
  const ids: string[] = []
  for (let next = scheduler.next(); next !== null; next = scheduler.next()) ids.push(next.id)
  return ids
}

describe('VastPodScheduler', () => {
  /** §3.3.1: sequenced ads play in numerical order, whatever order they appear in the document. */
  it('podPlaysInSequenceOrderNotDocumentOrder', () => {
    const scheduler = new VastPodScheduler([ad('c', 3), ad('a', 1), ad('b', 2)])
    expect(drain(scheduler)).toEqual(['a', 'b', 'c'])
    expect(scheduler.totalCount).toBe(3)
  })

  /** Non-sequenced ads are the "ad buffet" — held back, not played inline. */
  it('standAloneAdsAreNotPartOfThePod', () => {
    const scheduler = new VastPodScheduler([ad('pod-1', 1), ad('pod-2', 2), ad('spare')])
    expect(scheduler.totalCount).toBe(2)
    expect(drain(scheduler)).toEqual(['pod-1', 'pod-2'])
  })

  /** §3.3.1: a failed pod ad is substituted by an un-played stand-alone ad. */
  it('failedPodAdIsSubstitutedByAStandAloneAd', () => {
    const scheduler = new VastPodScheduler([ad('pod-1', 1), ad('pod-2', 2), ad('spare-1'), ad('spare-2')])
    scheduler.next()
    expect(scheduler.substituteForFailure()?.id).toBe('spare-1')
    expect(scheduler.substituteForFailure()?.id).toBe('spare-2')
    expect(scheduler.substituteForFailure(), 'each spare is used at most once').toBeNull()
  })

  /** With no stand-alone ad left, the player moves on — a failure must not end the break. */
  it('podContinuesWhenNoSubstituteRemains', () => {
    const scheduler = new VastPodScheduler([ad('pod-1', 1), ad('pod-2', 2)])
    expect(scheduler.next()?.id).toBe('pod-1')
    expect(scheduler.substituteForFailure()).toBeNull()
    expect(scheduler.next()?.id).toBe('pod-2')
  })

  /** The common single-ad response has no sequence at all and must still play. */
  it('singleStandAloneResponsePlays', () => {
    const scheduler = new VastPodScheduler([ad('only')])
    expect(scheduler.totalCount).toBe(1)
    expect(drain(scheduler)).toEqual(['only'])
  })

  it('emptyResponseYieldsNothing', () => {
    const scheduler = new VastPodScheduler([])
    expect(scheduler.totalCount).toBe(0)
    expect(scheduler.next()).toBeNull()
  })

  // MARK: - Counting

  /** §3.3.1: ads with no `sequence` are alternatives, not a running order. */
  it('responseOfOnlyStandAloneAdsPlaysOneOfThem', () => {
    const scheduler = new VastPodScheduler([ad('a'), ad('b'), ad('c')])
    expect(scheduler.totalCount, 'a buffet is one slot, not three').toBe(1)
    expect(drain(scheduler)).toEqual(['a'])
  })

  it('unplayedStandAloneAdsRemainAvailableAsSubstitutes', () => {
    const scheduler = new VastPodScheduler([ad('a'), ad('b'), ad('c')])
    scheduler.next()
    expect(scheduler.substituteForFailure()?.id).toBe('b')
    expect(scheduler.substituteForFailure()?.id).toBe('c')
  })

  /** A substitute fills the slot the failed ad occupied, so the position shown does not advance for it. */
  it('substituteBelongsToTheSamePodSlot', () => {
    const scheduler = new VastPodScheduler([ad('pod-1', 1), ad('pod-2', 2), ad('spare')])
    expect(scheduler.totalCount).toBe(2)
    expect(scheduler.next()?.id).toBe('pod-1')
    expect(scheduler.currentIndex, 'one slot consumed').toBe(1)
    expect(scheduler.substituteForFailure()?.id).toBe('spare')
    expect(scheduler.currentIndex, 'a substitute does not consume a new slot').toBe(1)
  })

  // MARK: - Looking ahead

  it('peekDoesNotConsumeTheEntry', () => {
    const scheduler = new VastPodScheduler([ad('first', 1), ad('second', 2)])
    expect(scheduler.peek()?.id).toBe('first')
    expect(scheduler.peek()?.id, 'looking twice changed what is next').toBe('first')
    expect(scheduler.next()?.id).toBe('first')
    expect(scheduler.peek()?.id).toBe('second')
  })

  it('peekIsEmptyOnceThePodIsSpent', () => {
    const scheduler = new VastPodScheduler([ad('only', 1)])
    scheduler.next()
    expect(scheduler.peek()).toBeNull()
  })
})
