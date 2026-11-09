import videojs from 'video.js'
import 'video.js/dist/video-js.css'
import { createVastVideojs, type VastVideojs } from '@kinodaran/vast-videojs'
import { VAST_STRINGS_EN, VAST_STRINGS_HY, type VastBreakPosition } from '@kinodaran/vast-kit'
import type { VastBeaconKind } from '@kinodaran/vast-core'
import { CONTENT_STREAM, SCENARIOS, type DemoScenario } from './scenarios.js'
import './style.css'

const player = videojs('player', { fluid: true, aspectRatio: '16:9' })
player.src({ src: CONTENT_STREAM, type: 'application/x-mpegURL' })

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const log = $<HTMLOListElement>('log')
const stateLabel = $<HTMLSpanElement>('state')
const hostUi = $<HTMLDivElement>('host-ui')
const hostUiLabel = $<HTMLSpanElement>('host-ui-label')
const hostUiSkip = $<HTMLButtonElement>('host-ui-skip')
const armenian = $<HTMLInputElement>('lang-hy')

let selected: DemoScenario = SCENARIOS[2]!
let vast: VastVideojs = build(selected)
let prerollPlayed = false

/**
 * One session per scenario only because the host-UI scenario needs
 * `allowsHiddenUi`, which is configuration. A real page keeps one session for
 * the life of its player.
 */
function build(scenario: DemoScenario): VastVideojs {
  const instance = createVastVideojs(player, {
    configuration: {
      allowsHiddenUi: scenario.hostDrawsUI === true,
      macroValues: { contentId: 'bipbop-demo' },
    },
    overlay: { strings: armenian.checked ? VAST_STRINGS_HY : VAST_STRINGS_EN },
  })
  const { session } = instance
  session.on('reported', (kind, ad) => record(describe(kind), ad?.id ?? '—'))
  session.on('adFailed', (error, ad) => record(`failed ${error}`, ad?.id ?? 'break', 'error'))
  session.on('adStarted', (ad, position) => record(`started ${position.index}/${position.total}`, ad.id, 'info'))
  session.on('allAdsFinished', () => record('break over', '', 'info'))
  session.on('skipControlUnavailable', (_ad, reason) => record(`skip control unavailable: ${reason}`, '', 'error'))
  session.subscribe(() => {
    const snapshot = session.getSnapshot()
    stateLabel.textContent = snapshot.state.type + (snapshot.pendingBreakCount ? ` · ${snapshot.pendingBreakCount} waiting` : '')
    // The host-drawn UI: everything it needs is in the snapshot.
    const drawn = snapshot.suppressesAdUi && snapshot.currentAd !== null
    hostUi.hidden = !drawn
    if (drawn) {
      hostUiLabel.textContent = `Host UI · ${Math.ceil(snapshot.remainingTime)}s`
      hostUiSkip.disabled = !snapshot.canSkip
      hostUiSkip.textContent = snapshot.canSkip ? 'Skip ›' : `Skip in ${Math.ceil(snapshot.timeUntilSkip ?? 0)}`
    }
  })
  return instance
}

hostUiSkip.addEventListener('click', () => vast.session.skip())

function play(scenario: DemoScenario, position: VastBreakPosition): void {
  for (const tag of scenario.tags) void vast.session.playBreak(tag(), { position })
}

// The pre-roll, on the first play — the moment Kinodaran's player starts its
// own today. Video.js's big play button is a gesture, so the session's
// prepare() has already run when this fires.
player.on('play', () => {
  if (prerollPlayed) return
  prerollPlayed = true
  play(selected, 'preroll')
})

$<HTMLButtonElement>('midroll').addEventListener('click', () => play(selected, 'midroll'))

armenian.addEventListener('change', () => {
  vast.destroy()
  vast = build(selected)
})

const list = $<HTMLOListElement>('scenarios')
for (const scenario of SCENARIOS) {
  const item = document.createElement('li')
  const button = document.createElement('button')
  button.type = 'button'
  button.innerHTML = `<strong>${scenario.title}</strong><span>${scenario.detail}</span>`
  button.setAttribute('aria-pressed', String(scenario === selected))
  button.addEventListener('click', () => {
    selected = scenario
    for (const other of list.querySelectorAll('button')) other.setAttribute('aria-pressed', 'false')
    button.setAttribute('aria-pressed', 'true')
    vast.destroy()
    vast = build(scenario)
    record(`selected: ${scenario.title}`, '', 'info')
    // After the film has started, picking a scenario plays it as a midroll.
    if (prerollPlayed) play(scenario, 'midroll')
  })
  item.appendChild(button)
  list.appendChild(item)
}

function describe(kind: VastBeaconKind): string {
  switch (kind.type) {
    case 'tracking':
      return kind.event
    case 'error':
      return `error ${kind.error}`
    case 'progress':
      return `progress ${kind.offset}s`
    case 'verificationNotExecuted':
      return `verificationNotExecuted ${kind.reason}`
    default:
      return kind.type
  }
}

function record(text: string, detail: string, tone: 'beacon' | 'info' | 'error' = 'beacon'): void {
  const item = document.createElement('li')
  item.className = tone
  const time = new Date().toLocaleTimeString([], { hour12: false })
  item.textContent = `${time}  ${text}${detail ? `  · ${detail}` : ''}`
  log.prepend(item)
  while (log.children.length > 200) log.lastElementChild?.remove()
}

// For poking at from the console. A getter, so it is always the live session.
Object.defineProperty(window, 'player', { value: player, configurable: true })
Object.defineProperty(window, 'vast', { get: () => vast, configurable: true })
