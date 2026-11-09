import { describe, expect, it } from 'vitest'
import { extensionValue, type VastAd } from '../src/VastAd.js'
import { isUiHidden } from '../src/VastUiSettings.js'
import { firstAd } from './support.js'

/**
 * {@link isUiHidden} is read straight out of the response, so it is tested the
 * way a response arrives: as XML through the parser, not as a hand-built model.
 */
describe('VastUiHidden', () => {
  // MARK: - Reading the key

  it('theKeyIsReadFromTheResponse', () => {
    expect(isUiHidden(ad('<UiHidden>1</UiHidden>'))).toBe(true)
  })

  /** The live AdFox tag sends `UiHideable`; `UiHidden` is the other spelling in the same family. */
  it('bothSpellingsAreRead', () => {
    for (const key of ['UiHidden', 'UiHideable']) {
      expect(isUiHidden(ad(`<${key}>1</${key}>`)), `${key} was not read`).toBe(true)
    }
  })

  /** Presence is the request the vendor intends, so an element carrying no text still counts. */
  it('anEmptyElementStillAsksForIt', () => {
    expect(isUiHidden(ad('<UiHidden/>'))).toBe(true)
    expect(isUiHidden(ad('<UiHidden></UiHidden>'))).toBe(true)
  })

  it('aCdataValueIsRead', () => {
    expect(isUiHidden(ad('<UiHidden><![CDATA[1]]></UiHidden>'))).toBe(true)
    expect(isUiHidden(ad('<UiHidden><![CDATA[0]]></UiHidden>'))).toBe(false)
  })

  /** A server sending `0` means "keep your UI", and inverting that would be worse than not reading the key at all. */
  it('anExplicitlyNegativeValueIsHonoured', () => {
    for (const value of ['0', 'false', 'NO']) {
      expect(isUiHidden(ad(`<UiHidden>${value}</UiHidden>`)), `${value} was read as yes`).toBe(false)
    }
  })

  // MARK: - What it must not read

  it('aResponseWithoutTheExtensionAsksForNothing', () => {
    expect(isUiHidden(firstAd(response(null)))).toBe(false)
  })

  /** Another vendor's extension is not this one, whatever it happens to contain. */
  it('theKeyIsIgnoredOutsideUiSettings', () => {
    expect(isUiHidden(firstAd(response('<Extension type="somethingElse"><UiHidden>1</UiHidden></Extension>')))).toBe(false)
  })

  /** The raw XML is still handed over untouched (§3.18) — interpreting one key must not consume the extension. */
  it('theExtensionIsStillHandedOverRaw', () => {
    const vendor = ad('<UiHideable>1</UiHideable>').extensions.find((extension) => extension.type === 'uiSettings')!
    expect(vendor.xml.includes('UiHideable')).toBe(true)
    expect(extensionValue(vendor, 'UiHideable')).toBe('1')
  })

  // MARK: - Fixtures

  function ad(uiSettings: string): VastAd {
    return firstAd(response(`<Extension type="uiSettings">${uiSettings}</Extension>`))
  }

  function response(extensions: string | null): string {
    const block = extensions === null ? '' : `<Extensions>${extensions}</Extensions>`
    return trimIndent(`
            <VAST version="4.3"><Ad id="a"><InLine>
              <AdSystem>test</AdSystem>
              <Impression><![CDATA[https://ads.test/impression]]></Impression>
              <Creatives><Creative><Linear>
                <Duration>00:00:20</Duration>
                <MediaFiles>
                  <MediaFile delivery="progressive" type="video/mp4"><![CDATA[https://ads.test/v.mp4]]></MediaFile>
                </MediaFiles>
              </Linear></Creative></Creatives>
              ${block}
            </InLine></Ad></VAST>
        `)
  }
})

/** Kotlin's `trimIndent()`, so each document is the one the Kotlin test parses. */
function trimIndent(text: string): string {
  const lines = text.split('\n')
  const indent = Math.min(...lines.filter((line) => line.trim().length > 0).map((line) => line.search(/\S/)))
  return lines
    .filter((line, index) => !((index === 0 || index === lines.length - 1) && line.trim().length === 0))
    .map((line) => line.slice(indent))
    .join('\n')
}
