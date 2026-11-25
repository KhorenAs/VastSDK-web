# Going live

What this SDK still needs before it serves real ads on kinodaran.com, ordered by
what blocks the road rather than by effort. Items that close are struck through
with the commit that closed them — a list that only grows is a list nobody reads
twice.

State: `npm test` passes 428 tests — 177 in `vast-core`, every core suite of
VastSDK-apple and VastSDK-android ported against the same fixtures plus the
web's own macros and parser repair; 227 in `vast-kit`, whole breaks driven
through a scripted ad element under jsdom, the overlay, the guard that puts
back a seek or a speed nobody in the session asked for, and Picture-in-Picture
(the window handed over and back, the film's element lent, WebKit's emptied
`pictureInPictureElement`, a slow or refused handoff); and 24 in
`vast-videojs`, against a fake Video.js player and — where what is relied on is
Video.js's own event dispatcher — the real Video.js 8. Writing those found six defects —
four of them shared with the Android SDK (a stall reported as 402 but ended as
405, a stall with no `<Error>` URI going unannounced, a failed creative's hold
leaking into the next, a beacon that keeps failing never ageing out) — and all
six are fixed here.
`npm run typecheck` and `npm run build` are clean. The demo has been run in a
Chromium-based browser against Google's public IMA sample tags: the tag resolved
over CORS, the creative played, every beacon reached Google's tracking hosts,
skip and a three-break series behaved, and the film resumed once, where it
stopped. Desktop Safari 27 has run the demo's pre-roll and mid-rolls with the
film in a PiP window: the ads played in the film's element, the window never
moved, and the film came back to it after a skip and after a played-out ad,
two breaks in a row.

## Blockers

**1. Publishing.** The packages are not on a registry. npm needs the `@kinodaran`
scope created under the owner's account and an automation token as a repository
secret; GitHub Packages needs a repository to publish from. The owner's account,
the owner's step. Until then `npm pack` makes installable tarballs.

**2. The repository.** This is a local git repository with no remote. Create
`KhorenAs/VastSDK-web` (or under the Kinodaran organisation) and push; CI
(test, typecheck, build on every push) follows the Android repository's workflow.

**3. Real browsers and devices.** jsdom answers the logic; it does not answer
autoplay policy, iOS Safari's gesture rules, iPhone native fullscreen, or how a
TV remote's keys arrive. Desktop Chrome and Safari have run the demo (above).
Still to run: Safari on iPhone and iPad, Chrome on Android, Firefox — including
a mid-roll asked for while its PiP window plays on a hidden tab — and, if
Kinodaran ships TV web apps, Tizen and webOS.

**4. kinodaran.com itself.** Replace the IMA calls in the player's ad controller
(README, "Replacing IMA on kinodaran.com") on a branch of the site, and confirm
two things about Kinodaran's own ad server that only the live site can answer:
that it answers credentialed CORS requests for the VAST tag, and that every
tracking URL it emits is https. Two decisions come with it for Safari's PiP
window (item 9a): the site's `vhs.overrideNative: true` keeps the film behind
a `MediaSource` there, and lending a DRM-protected film
(`sameElementPiPForProtectedContent`) needs a check against the licence server
first.

## Blockers only for programmatic demand

Skip this section while the inventory is direct-sold.

**5. No Open Measurement adapter.** `session.measurement` is the seam and it is
deliberately empty, so every vendor hears `verificationNotExecuted`. Honest, and
incompatible with selling against a viewability contract. Needs the IAB OM SDK
for Web and its licence; open on Apple and Android too.

## Important, not blocking

**6. ~~Undeclared namespace prefixes.~~** `DOMParser` rejects a response that
uses a prefix (`xsi:`) it never declared, where the native parsers read past it.
The parser now declares the missing prefixes on the root element and asks once
more, which changes nothing for XML broken any other way.

**6a. Port the shared fixes back.** Four of the defects the kit tests found are
in the Android SDK too, by inspection — `stall()`, `outcomeFor()`, `slotFailed()`
and the retry queue's re-stamping in `VastHttpTransport` — and the Apple SDK is
worth checking for the same four. A fifth was found testing the demo by hand: a
tracker that never answers had the whole retry backlog re-sent with every new
beacon (an ad blocker makes one of every tracker it knows), which ran a long
browser session out of connections. Here retries are now rationed — one batch of
50 at most every 30 seconds, five tries per beacon. Android's `fire()` drains
the whole queue the same way and should get the same ration.

**6b. A resume the browser refuses.** When the page comes back and the browser
will not restart the held ad, the ad sits paused while the state says `playing`,
and the stall watchdog — which does not run while the element is paused — never
fires. Rare (a browser that let the ad start lets it resume), but it should
become a visible `paused`.

**7. HLS creatives outside Safari.** The ad element plays what the browser plays
natively. An optional hls.js hook (the host already has one inside VHS) would let
an `.m3u8`-only creative play in Chrome and Firefox.

**8. A series position.** Kinodaran requests the same tag `max_count` times and
shows "ad 2 of 3" across the series. Each queued break reports its own position;
the host counts the series. A `playBreak` option that numbers a series as one
break would let the SDK's overlay show it too.

**9. ~~Picture in Picture.~~** A break that starts with the film in a PiP window
plays in that window and gives it back (README, "Picture-in-Picture"). Chrome
hands the window to the ad's element and back; Safari, which cannot move a
window between two elements, plays the mid-roll in the film's own element,
with Video.js kept from hearing it. A mid-roll on a hidden page waits until its
ad can be seen, and the browser's own skip button comes from `skipad` once the
skip is due.

**9a. PiP where the film's element cannot be lent.** In Safari, a film behind a
`MediaSource` (kinodaran.com's `vhs.overrideNative: true`), or DRM-protected
without the opt-in, falls back to handing the window over between elements: the
window animates back into the page and out again, and WebKit — which empties
`pictureInPictureElement` when the old element's exit lands late — refuses the
next handoff without a user gesture, so the second mid-roll of one PiP session
plays on the page. Lending a `MediaSource` film would mean loading it again
through Video.js (`player.src()`), as IMA does. Firefox's PiP has no API, so a
mid-roll there waits for the page. Safari's PiP window also keeps its skip-10s
buttons during an ad — WebKit gives pages nothing like AVKit's
`requiresLinearPlayback` — and the seeks they make are put back.

**10. The AdChoices icon is parsed but not drawn.** As on Apple and Android.

**11. Video.js 8's own TypeScript types.** `VideoJsPlayerLike` declares
`currentTime()` and `volume()` as returning `number`; Video.js 8's types return
`number | undefined`, so a TypeScript host passes a real player only through a
cast. JavaScript hosts, kinodaran.com among them, are not affected.
