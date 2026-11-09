# Privacy

What VastSDK for the Web does with data, for whoever writes the site's privacy
notice and for anyone reviewing what an ad break sends.

The short answer: **the SDK collects nothing of its own.** It reads no
identifier, sets no cookie, keeps no profile, and sends no analytics anywhere.
What leaves the browser goes to the URLs the ad server put in its own response,
and carries the values the host chose to supply — nothing the SDK found out by
itself.

## What leaves the browser, and to whom

| Request | Sent to | Carries |
|---|---|---|
| The ad tag | The URL the host passed to `playBreak`, then each `VASTAdTagURI` the responses redirect to | Whatever the host put in the URL, and the browser's cookies for that ad server (`requestCredentials`, default `include`) |
| Tracking beacons — impression, quartiles, clicks, errors | The URIs in the response's `<Impression>`, `<Tracking>`, `<Error>`, `<ClickTracking>` and the like | The §6 macros the ad server asked for (below), and the browser's cookies for that host |
| The creative | The `<MediaFile>` URL the SDK chose | Nothing beyond the request itself |

Every one of these goes to a server the ad response names. The SDK adds no
endpoint of its own — there is no Kinodaran server in the path unless the ad
server is one.

Cookies are the one thing that differs from the native SDKs: a browser attaches
the ad server's own cookies to its requests, as it does for IMA. That is the
ad server's data, governed by the site's consent banner; the SDK neither reads
nor writes any. A host that must not send them sets `requestCredentials: 'omit'`
for tags and supplies a `VastBeaconTransport` for beacons.

## Macros

A tracking URI can ask for values by macro (VAST 4.3 §6). The SDK answers the
ones it can know without asking anyone, and leaves the rest to the host:

- **Answered by the SDK:** playhead, the creative's URL and MIME type, player
  size, muted and fullscreen state, the page's URL and domain (`[PAGEURL]`,
  `[DOMAIN]`), the browser's user agent (`[DEVICEUA]`, unless the host supplies
  one), the SDK's own name and version (`[CLIENTUA]`), where the break sits
  (`[BREAKPOSITION]`, from `playBreak`'s `position`), a per-break transaction ID,
  a cache buster, the time.
- **Only ever what the host supplies,** through `configuration.macroValues`: an
  advertising identifier (`[IFA]`, `[IFATYPE]`), limit-ad-tracking
  (`[LIMITADTRACKING]`), the TCF consent string (`[GDPRCONSENT]`), which
  regulations apply (`[REGULATIONS]`), and what the content is.

An unsupplied value goes out as `-1`, the specification's "unknown". The SDK
never fills one in by guessing. A browser has no device advertising ID, so `[IFA]`
stays `-1` unless the host has a first-party one and the viewer's consent to use it.

## What is stored, where, and for how long

One `localStorage` entry, `kinodaran.vast.pending-beacons`: tracking URLs whose
request failed at the network level, kept so they can be sent again later — at
most 500 of them, and none older than six hours. They carry whatever the macros
put in them, a consent string among them, which is why they are not kept longer.
Storage is per origin and never leaves the browser. Where `localStorage` is
unavailable the queue lives in memory for the life of the page.

Nothing else is stored: no cookie, no IndexedDB, no session storage.
