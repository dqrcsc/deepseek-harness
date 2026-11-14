// @vitest-environment jsdom
/** The theme bootstrap injection row and the resulting pre-plugin browser theme. */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootThemeInjections } from '../src/boot-theme.ts'
import { createBrandSnapshot, type BrandSnapshot, type FontSizes, type ThemePreference, type ThemeStyle } from '../src/theme-settings.ts'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
}

function executeBootstrap(preference?: ThemePreference, fontSizes?: FontSizes, style?: ThemeStyle, brand?: BrandSnapshot): void {
  for (const row of bootThemeInjections(preference, fontSizes, undefined, style, brand)) {
    if (row.kind === 'script') runInNewContext(row.text, { document, matchMedia: globalThis.matchMedia })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.dsThemeSource
  delete document.body.dataset.dsThemeStyle
  delete document.body.dataset.dsBrandPreset
  delete document.body.dataset.dsBrandLabelMode
  delete document.body.dataset.dsBrandGreetingMode
  delete document.body.dataset.dsBrandCustomName
  delete document.body.dataset.dsBrandCustomGreeting
  document.body.removeAttribute(DARK_ATTRIBUTE)
  for (const name of ['--dsh-content-font-size', '--dsh-code-font-size', '--dsh-terminal-font-size']) document.body.style.removeProperty(name)
  for (const kind of ['text', 'code', 'terminal']) document.body.style.removeProperty(`--dsh-font-family-${kind}`)
})

describe('theme bootstrap row', () => {
  it('colors the body with head CSS before applying body state', () => {
    mockSystemDark(false)
    const [head, body] = bootThemeInjections('dark')
    expect(head).toMatchObject({ kind: 'style' })
    expect(body).toMatchObject({ kind: 'script', placement: 'body' })
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:dark}body{background-color:#0d1017;--dsh-boot-bg:#0d1017}')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    if (body?.kind !== 'script') throw new Error('theme body bootstrap row is not a script')
    runInNewContext(body.text, { document, matchMedia: globalThis.matchMedia })
    expect(document.documentElement.dataset.dsThemeSource).toBe('dark')
    expect(document.body.dataset.dsThemeStyle).toBe('antigravity')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('lets durable light override a dark OS and clears stale dark state', () => {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    mockSystemDark(true)
    const [head] = bootThemeInjections('light')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:light}body{background-color:#f6f8fe;--dsh-boot-bg:#f6f8fe}')
    executeBootstrap('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(document.body.dataset.dsThemeStyle).toBe('antigravity')
  })

  it.each([
    [true, true],
    [false, false],
  ] as const)('resolves system=%s for the body palette', (matches, dark) => {
    mockSystemDark(matches)
    executeBootstrap('system')
    expect(document.documentElement.dataset.dsThemeSource).toBe('system')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(dark)
  })

  it('uses a media query for the system canvas palette', () => {
    const [head] = bootThemeInjections('system')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(
      ':root{color-scheme:light}body{background-color:#f6f8fe;--dsh-boot-bg:#f6f8fe}'
      + '@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background-color:#0d1017;--dsh-boot-bg:#0d1017}}',
    )
  })

  it.each([
    ['codex', '#f7f7f8', '#0f0f10'],
    ['warm', '#f6f3eb', '#191714'],
    ['linear', '#f4f5f8', '#0b0c0e'],
    ['craft', '#f5f8fc', '#11141b'],
    ['aurora', '#f7f6fe', '#11111c'],
    ['nord', '#eceff4', '#2e3440'],
    ['classic', '#fff', '#151517'],
  ] as const)('embeds canvas colors and dataset for theme style %s', (style, lightBg, darkBg) => {
    const [head] = bootThemeInjections('system', undefined, undefined, style)
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(
      `:root{color-scheme:light}body{background-color:${lightBg};--dsh-boot-bg:${lightBg}}`
      + `@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background-color:${darkBg};--dsh-boot-bg:${darkBg}}}`,
    )
    executeBootstrap('light', undefined, style)
    expect(document.body.dataset.dsThemeStyle).toBe(style)
  })

  it('defaults to system and falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    executeBootstrap()
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('writes the durable font sizes and their defaults', () => {
    mockSystemDark(false)
    executeBootstrap('light', { text: 22, code: 15, terminal: 18 })
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('22px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('15px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('18px')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('11px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('13px')
  })

  it('writes normalized durable font lists and leaves empty lists unset', () => {
    mockSystemDark(false)
    const [, body] = bootThemeInjections('light', undefined, { text: 'Inter', code: '', terminal: 'MesloLGS NF</script>, monospace' })
    if (body?.kind !== 'script') throw new Error('theme body bootstrap row is not a script')
    expect(body.text).not.toContain('<')
    runInNewContext(body.text, { document, matchMedia: globalThis.matchMedia })
    expect(document.body.style.getPropertyValue('--dsh-font-family-text')).toBe('"Inter"')
    expect(document.body.style.getPropertyValue('--dsh-font-family-code')).toBe('')
    expect(document.body.style.getPropertyValue('--dsh-font-family-terminal')).toBe('"MesloLGS NF/script", monospace')
  })

  it('embeds default and custom brand dataset attributes safely', () => {
    mockSystemDark(false)
    executeBootstrap('light')
    expect(document.body.dataset.dsBrandPreset).toBe('reins')
    expect(document.body.dataset.dsBrandLabelMode).toBe('bilingual')
    expect(document.body.dataset.dsBrandGreetingMode).toBe('brand')
    expect(document.body.dataset.dsBrandCustomName).toBeUndefined()
    expect(document.body.dataset.dsBrandCustomGreeting).toBeUndefined()

    const customBrand = createBrandSnapshot({
      preset: 'loom',
      labelMode: 'custom',
      customName: '  灵枢 Studio  ',
      greetingMode: 'custom',
      customGreeting: '  经纬万象  ',
    })
    executeBootstrap('light', undefined, 'antigravity', customBrand)
    expect(document.body.dataset.dsBrandPreset).toBe('loom')
    expect(document.body.dataset.dsBrandLabelMode).toBe('custom')
    expect(document.body.dataset.dsBrandGreetingMode).toBe('custom')
    expect(document.body.dataset.dsBrandCustomName).toBe('灵枢 Studio')
    expect(document.body.dataset.dsBrandCustomGreeting).toBe('经纬万象')
  })
})
