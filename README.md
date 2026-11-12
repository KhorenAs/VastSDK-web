# VastSDK for the Web

A native VAST 4.3 linear-video ad SDK for browsers — desktop, mobile and
smart-TV web apps. No Google IMA, no VPAID, no iframes.

It is the web counterpart of [VastSDK-apple](https://github.com/KhorenAs/VastSDK-apple)
and [VastSDK-android](https://github.com/KhorenAs/VastSDK-android) and behaves the
same way: the three share the specification, the test fixtures and every
behavioural decision, and every core test suite of the other two is ported here
against the same files. Where the web needs something native platforms do not —
or cannot do something they can — this README says so.

4.3 is what it implements; 2.0, 3.0 and every 4.x **parse through the same
version-tolerant path**, because real ad servers still send them. An element the
SDK does not know is skipped rather than rejected; the only document it refuses
outright is a pre-3.0 one, which gets VAST error 102.

## Packages

```
@kinodaran/vast-core      pure TypeScript: parser, wrapper chains, macros, tracking — no player, no network
@kinodaran/vast-kit       the session: plays a break over the host's player, beacons, the ad UI
@kinodaran/vast-videojs   Video.js 7 and 8 adapter — the replacement for videojs-ima
demo/                     Video.js page with the Apple and Android demos' scenarios
```

The SDK ships ES2017 output, ESM and CommonJS, and type declarations.
The browser loads dash.js on demand when it selects a DASH ad.

### Installing

Not on npm yet — publishing needs the `@kinodaran` scope, which is the owner's
step ([GO-LIVE.md](GO-LIVE.md)). Until then, build and pack:

```bash
npm install && npm run build
npm pack --workspace @kinodaran/vast-core --workspace @kinodaran/vast-kit --workspace @kinodaran/vast-videojs
```

and install the three `.tgz` files in the host. Once published:

```bash
npm install @kinodaran/vast-videojs @kinodaran/vast-kit @kinodaran/vast-core
```

## Playing a break with Video.js

```ts
import { createVastVideojs } from '@kinodaran/vast-videojs'

const vast = createVastVideojs(player)

player.one('play', () => {
  vast.session.playBreak(prerollTagUrl, { position: 'preroll' })
})
```

That is the whole integration for a pre-roll. The break plays over `player.el()`
— so it follows the player into fullscreen — in a `<video>` element of the
session's own. The film is **paused, never unloaded**: VHS keeps its buffer, EME
keeps its keys, and the content resumes from the frame it stopped on with no new
licence request. That is the difference from an IMA integration, which swaps the
ad into the content element and has to rebuild the DRM stream afterwards.

For the length of the break the adapter takes the control bar away, undoes any
`play` on the content (a hotkey, the host's own code), and restores everything
afterwards from what it saved rather than from defaults. Every tap, click or key
on the player calls `session.prepare()`, which is what lets iOS Safari start the
ad with sound — the job IMA gives `initializeAdDisplayContainer()`.

`playBreak` never rejects. It settles when the break is over, however it went:

```ts
const { outcome, adsStarted } = await vast.session.playBreak(tag, { position: 'midroll' })
// outcome: { type: 'completed' } | { type: 'skipped' } | { type: 'failed', error: 303 }
```

A response already in hand goes in as XML:

```ts
vast.session.playBreak({ xml, baseUrl: tagUrl })
```

### Hosted VAST on the web

Pass the player's capabilities with the Kinodaran Ads request. Safari advertises
HLS when its video element supports it. Chrome and Firefox advertise DASH when
Media Source Extensions can play H.264. The hosted VAST can also offer MP4 for
devices without adaptive playback or when a stream fails before playback starts.

```ts
import { webVideoFormats } from '@kinodaran/vast-kit'

const requestBody = {
  ...adRequest,
  device: { ...adRequest.device, platform: 'web' },
  video_formats: webVideoFormats(),
}
// Send requestBody to /serve/ad-request and pass the returned VAST XML to playBreak.
```

### Without Video.js

```ts
import { VastAdSession, VastAdOverlay, htmlVideoContent } from '@kinodaran/vast-kit'

const session = new VastAdSession({ container: playerBox, content: htmlVideoContent(video) })
new VastAdOverlay(session)
playButton.addEventListener('click', () => session.prepare())
```

`content` is any `VastContentPlayer` — two methods, `pauseForBreak()` and
`resumeAfterBreak()`. Leave it out and the host pauses and resumes its own player
around `playBreak`.

### Breaks on demand

Calling `playBreak` while a break is on screen queues the new one. Breaks asked
for together play one after another, in order, and **the content comes back once,
after the last** — two breaks asked for together are one interruption to the
viewer. `pendingBreakCount` in the snapshot says how many are waiting.

A `preroll` holds the content from the moment it is asked for. Any other break
leaves the content playing while its response comes back and stops it only once
there is an ad to show: nothing should look as though it stopped for a break that
turns out empty.

## Replacing IMA on kinodaran.com

kinodaran.com today runs Video.js 7 with VHS and contrib-eme (Widevine and
FairPlay), and plays ads through the `videojs-ima` plugin from its own ad
controller. The controller's scheduling stays as it is — the backend's
`preroll`/`midroll`/`endroll` config, `max_count`, `ad_frequency` and the
"rewarded seconds" budget are Kinodaran's rules, not the SDK's. Only the calls
into IMA change:

| Today (`videojs-ima`) | With VastSDK |
|---|---|
| `player.ima(player, { disableCustomPlaybackForIOS10Plus: true, … })` | `const vast = createVastVideojs(player, { overlay: false, configuration: { skipPresentation: 'host' } })` |
| `player.initializeAdDisplayContainer()` | nothing — the adapter calls `prepare()` on every gesture |
| `player.setContentWithAdTag(null, url)` + `requestAds()`, `max_count` times | `for (let i = 0; i < max_count; i++) vast.session.playBreak(url, { position })` |
| `adsManager` events (`STARTED`, `COMPLETE`, `ALL_ADS_COMPLETED`, `AD_ERROR`) | `session.on('adStarted' \| 'adFinished' \| 'allAdsFinished' \| 'adFailed', …)` |
| `getCurrentAd().data.skipTimeOffset`, `getRemainingTime()` | `session.getSnapshot()` — `timeUntilSkip`, `canSkip`, `remainingTime`, `adPosition` |
| `adsManager.stop()` (the skip button) | `session.skip()` |
| `AdsRenderingSettings.bitrate = 6506` | nothing — the session picks the rendition for the player's size |
| `player.currentTime(lastTime)` after the break | nothing — the adapter restores it |
| `ima3.js` `<script>` tag | removed |

Kinodaran's React overlay — the skip button with its countdown and the "ad 1 of
3" counter — can stay. React reads the session directly:

```tsx
const snapshot = useSyncExternalStore(vast.session.subscribe, vast.session.getSnapshot)
// snapshot.canSkip, snapshot.timeUntilSkip, snapshot.remainingTime, snapshot.currentAd …
<button disabled={!snapshot.canSkip} onClick={() => vast.session.skip()}>…</button>
```

With `skipPresentation: 'host'` the SDK leaves the skip control to that button;
without it, drop `overlay: false` and the SDK's own overlay draws everything, in
Armenian on an Armenian page.

Two things to confirm on the live site before switching: that Kinodaran's own ad
server answers credentialed CORS requests (the loader retries without cookies if
it does not, at the cost of a round trip), and that its tracking hosts are all
https (an https page cannot send an http beacon at all).

## The ad UI

```ts
new VastAdOverlay(session, { strings: 'hy', onClickThrough: (url) => open(url) })
```

The overlay draws the badge, the countdown, the skip control, the click layer, a
"Learn more" button and — when the browser refused sound — an unmute control. Two
of those are requirements, not decoration: a skippable ad must be offered a skip
control (§2.3), and the ad must be clickable (§3.10.1).

It draws in the session's layer, above the ad's video and inside the player, so
it follows the player into fullscreen and cannot end up under the host's skin.
Every element has a stable class (`vast-badge`, `vast-skip`, `vast-learn-more`,
`vast-unmute`, `vast-click`) and the look comes from CSS custom properties
(`--vast-fg`, `--vast-chip-bg`, `--vast-skip-bg`, `--vast-skip-bottom`,
`--vast-inset`, `--vast-focus`, `--vast-font`), so the host owns the style while
the SDK owns the behaviour. Strings ship in English and Armenian, the same as the
Apple SDK's.

The skip control is measured where it is drawn: a host stylesheet that hides or
shrinks it below 24×24 px (WCAG 2.5.8) is reported through
`skipControlUnavailable` rather than silently leaving a skippable ad unskippable.

Who draws the skip control is `skipPresentation`: `'sdk'` (the default), `'host'`
— the host reads `canSkip` and `timeUntilSkip` and calls `skip()` — or
`'unsupported'`, which refuses a skippable ad with error 200 rather than playing
it without one. A response carrying the `uiSettings` UI-hidden key hands the
whole UI to the host, but only when the host has set `allowsHiddenUi`: a vendor
key cannot take the §2.3 promise away from a host that never agreed to keep it.

## What the session holds the line on

- **No seeking, no speed-up.** The ad element has no controls, Picture in
  Picture or remote playback, and the content's control bar is gone for the
  break. `permitsPlaybackControls` in the snapshot is `false` throughout — and in
  the gap between two queued breaks. What no viewer can reach, devtools or a
  "skip ads" extension still can, so a seek the session did not make is put
  back where playback had reached and a playback rate goes back to 1× — the
  web's version of Media3 refusing seeks during an ad. A seek on the hidden film
  is undone when the break ends.
- **Nothing unwatched.** A hidden tab keeps decoding video with sound, so the
  session holds the ad while the page is hidden and resumes it when it is back —
  not reported as a pause, because nobody paused. Clicking through to the
  advertiser opens a tab, which hides the page, which holds the ad.
- **Autoplay.** Where the browser refuses sound, the ad starts muted and the
  overlay offers to unmute. A muted start is not a §3.14.1 `mute` — the viewer
  chose nothing — and unmuting is reported as `unmute`. Where it refuses even
  muted playback, the ad fails with 405 and the content plays.
- **The system's media controls.** Media keys, a headset, the lock screen and the
  OS media hub name the ad while it plays, and cannot seek or skip past it
  (`mediaSession: 'describesAd'`, the default).
- **iPhone fullscreen.** iPhone Safari plays `<video>` fullscreen in a layer the
  page cannot draw over, so a break leaves it first — as IMA does on iOS.

## Television

On a smart-TV browser the overlay's skip control takes focus when it unlocks. A
transparent click layer under a remote can never take focus, so on a TV with
`clickPresentation: 'surface'` the session reports `clickThroughUnavailable`. Use
`'host'` with a focusable control of your own, or `'disabled'` to opt out
knowingly.

## Knowing what was reported

```ts
session.on('reported', (kind, ad) => { /* … */ })
```

Called once per distinct kind, in the order the beacons went out, whether or not
the network accepted them. A response with three `<Impression>` URLs is three
beacons and one impression. The rest of the state is in `getSnapshot()`, which
returns the same object until something changes — `useSyncExternalStore`-ready.

## Measurement

`session.measurement` is where an Open Measurement integration plugs in; the SDK
parses `<AdVerifications>` and never executes them. With nothing configured,
every vendor that asked is told `verificationNotExecuted` and every
`<ViewableImpression>` hears `<ViewUndetermined>`, because that is the truth.

## Delivery and privacy

Beacons go out as `fetch` with `keepalive`, so a tab closing the moment an ad
completes does not take the `complete` request down with it. What fails is kept
in a `localStorage` retry queue — Android's format — and sent again on a later
flush, across page loads. Retries are rationed: one batch of at most 50, at most
every 30 seconds per page, and a beacon that fails five of them is let go. An
ad blocker turns every tracker it knows into one that never answers; unrationed,
that backlog went out again with every new beacon.

**A browser knows less about delivery than an app does.** Tracking hosts send no
CORS headers, so beacons go out `no-cors` and their responses are opaque: the
page learns that a server answered, never which status. The native SDKs retry a
5xx; here any answer is final and only a request that got none is retried. A host
with its own pipeline supplies a `VastBeaconTransport`.

The SDK collects nothing of its own; [PRIVACY.md](PRIVACY.md) has what leaves the
browser, what is stored, and for how long.

## Building

```bash
npm install
npm test            # every package, under jsdom
npm run typecheck   # the whole repository as one program
npm run build       # ESM + CJS + .d.ts for each package, and the demo
npm run demo        # http://localhost:5173
```

Node 20 or later. Packages import each other from source in tests, typecheck and
the demo, so a change in `vast-core` is checked against `vast-kit` before
anything is built.

## Known issues

**HLS creatives play only where the browser plays HLS itself** — Safari. The ad
element has no hls.js behind it, so an ad offering only an `.m3u8` is a 403 in
Chrome and Firefox; one offering an `.mp4` too plays the `.mp4`.

**The AdChoices icon is parsed but not drawn.** As on Apple and Android.

## License

MIT — see [LICENSE](LICENSE).
