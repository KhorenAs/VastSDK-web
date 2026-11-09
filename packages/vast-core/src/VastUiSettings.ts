import { extensionValue, type VastAd } from './VastAd.js'

/**
 * The one vendor convention this SDK interprets.
 *
 * `<Extension type="uiSettings">` is nobody's standard: §3.18 leaves
 * `<Extensions>` entirely to vendors, and {@link extensionValue} deliberately
 * stops at *reading* a key rather than deciding what it means. This is the
 * single exception to that, kept in one file so the exception stays countable —
 * and surfaced only through {@link isUiHidden}.
 *
 * It lives in `vast-core` because a host depending on `vast-core` alone — its
 * own player, its own UI — is exactly the host that most needs the answer.
 */
const EXTENSION_TYPE = 'uisettings'

/**
 * Both spellings seen in the wild. The live AdFox tag this SDK was tested
 * against sends `<UiHideable>`; `<UiHidden>` is the spelling used elsewhere in
 * the same family. Reading both costs nothing, and missing the key costs a
 * whole break drawn with the wrong UI — silently, because the response still
 * looks fine.
 */
const HIDDEN_KEYS = ['UiHidden', 'UiHideable'] as const

/**
 * Whether this response asks the player to draw no UI of its own.
 *
 * Read from `<Extension type="uiSettings">` — `<UiHidden>`, or the
 * `<UiHideable>` spelling the live AdFox tag sends. A vendor convention
 * rather than VAST, and the one key the SDK interprets instead of merely
 * handing over. Presence is the request, so `<UiHidden/>` with no text
 * counts; only an explicitly negative value reads as "keep your UI".
 *
 * **This is what the response asked for, and on its own it changes nothing.**
 * A response cannot hide the SDK's UI by itself — that would let a vendor
 * decide whether the host honours §2.3. The host has to allow it too.
 */
export function isUiHidden(ad: VastAd): boolean {
  for (const vendor of ad.extensions) {
    if (vendor.type?.toLowerCase() !== EXTENSION_TYPE) continue
    for (const key of HIDDEN_KEYS) {
      const value = extensionValue(vendor, key)
      if (value === null) continue
      return isAffirmative(value)
    }
  }
  return false
}

function isAffirmative(value: string): boolean {
  switch (value.trim().toLowerCase()) {
    case '0':
    case 'false':
    case 'no':
      return false
    default:
      return true
  }
}
