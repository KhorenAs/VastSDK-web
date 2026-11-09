# Going live

What this SDK still needs before it serves real ads on kinodaran.com, ordered by
what blocks the road rather than by effort. Items that close are struck through
with the commit that closed them — a list that only grows is a list nobody reads
twice.

State: `npm test` passes 395 tests — 177 in `vast-core`, every core suite of
VastSDK-apple and VastSDK-android ported against the same fixtures plus the
web's own macros and parser repair; 200 in `vast-kit`, whole breaks driven
through a scripted ad element under jsdom, the overlay, and the guard that puts
back a seek or a speed nobody in the session asked for; and 18 in
`vast-videojs`, against a fake Video.js player. Writing those found six defects —
four of them shared with the Android SDK (a stall reported as 402 but ended as
405, a stall with no `<Error>` URI going unannounced, a failed creative's hold
leaking into the next, a beacon that keeps failing never ageing out) — and all
six are fixed here.
`npm run typecheck` and `npm run build` are clean. The demo has been run in a
Chromium-based browser against Google's public IMA sample tags: the tag resolved
over CORS, the creative played, every beacon reached Google's tracking hosts,
skip and a three-break series behaved, and the film resumed once, where it
stopped.

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
TV remote's keys arrive. Safari on iPhone and iPad, Chrome on Android, Firefox,
desktop Safari and Chrome, and — if Kinodaran ships TV web apps — Tizen and webOS.

**4. kinodaran.com itself.** Replace the IMA calls in the player's ad controller
(README, "Replacing IMA on kinodaran.com") on a branch of the site, and confirm
two things about Kinodaran's own ad server that only the live site can answer:
that it answers credentialed CORS requests for the VAST tag, and that every
tracking URL it emits is https.

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
worth checking for the same four.

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

**9. Picture in Picture.** The ad element refuses it; content already in a
Picture in Picture window when a break starts is paused there while the ad plays
in the page. The Apple and Android SDKs have a policy for this; the web has none
yet.

**10. The AdChoices icon is parsed but not drawn.** As on Apple and Android.
