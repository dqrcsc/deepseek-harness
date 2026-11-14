// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import { bootThemeInjections } from '../src/boot-theme.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ThemeSettings,
  ThemeSnapshot,
  ThemeTokenOverrides,
} from '@deepseek-ai/dsh-client-ui-theme/client'
import { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'

const defaultBrandFields = {
  brandPreset: 'reins' as const,
  brandLabelMode: 'bilingual' as const,
  customBrandName: '',
  brandGreetingMode: 'brand' as const,
  customBrandGreeting: '',
}

const make = (host = stubConfigForm<ThemeSettings>()): {
  ctx: Context
  theme: ThemeRuntime
  events: ThemeSnapshot[]
  host: StubConfigForm<ThemeSettings>
} => {
  const ctx = new Context()
  const events: ThemeSnapshot[] = []
  ctx.on('theme/change', (snapshot) => { events.push(snapshot) })
  return { ctx, theme: new ThemeRuntime(ctx, host.scope), events, host }
}

describe('ThemeRuntime', () => {
  it('defaults to the system preference resolved against prefers-color-scheme', () => {
    const { theme } = make()
    const snapshot = theme.getTheme()
    expect(snapshot.preference).toBe('system')
    expect(snapshot.style).toBe('antigravity')
    expect(snapshot.brand).toEqual({
      preset: 'reins',
      labelMode: 'bilingual',
      customName: '',
      greetingMode: 'brand',
      customGreeting: '',
      title: '执辔 Reins',
    })
    expect(snapshot.fontSizes.text).toBe(14)
    // jsdom matchMedia is absent; system resolves to light.
    expect(snapshot.active.id).toBe('light')
    expect(snapshot.active.colorScheme).toBe('light')
    expect(snapshot.themes.map(t => t.id)).toEqual(['light', 'dark'])
  })

  it.each(['light', 'dark', 'system'] as const)('preserves boot preference %s until Host settings arrive', (preference) => {
    for (const row of bootThemeInjections(preference, undefined, undefined, 'warm')) {
      if (row.kind === 'script') runInNewContext(row.text, { document })
    }
    try {
      const { theme, host, events } = make()
      expect(theme.getTheme().preference).toBe(preference)
      expect(theme.getTheme().style).toBe('warm')
      expect({ preference: theme.getTheme().preference, palette: theme.getTheme().active.colorScheme }).toMatchSnapshot()
      expect(events).toEqual([])
      host.publish({ status: 'ready', value: {
        preference: 'light', style: 'craft', ...defaultBrandFields, fontSize: 14, codeFontSize: 13, terminalFontSize: 13,
        textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
      }, revision: 1, writable: true })
      expect(theme.getTheme().preference).toBe('light')
      expect(theme.getTheme().style).toBe('craft')
      expect(host.set).not.toHaveBeenCalled()
    } finally {
      delete document.documentElement.dataset.dsThemeSource
      delete document.body.dataset.dsThemeStyle
      delete document.body.dataset.dsBrandPreset
      delete document.body.dataset.dsBrandLabelMode
      delete document.body.dataset.dsBrandGreetingMode
      document.body.removeAttribute('data-ds-dark-theme')
      document.body.removeAttribute('style')
    }
  })

  it('uses the default when the boot preference, style, or brand attributes are invalid', () => {
    document.documentElement.dataset.dsThemeSource = 'invalid'
    document.body.dataset.dsThemeStyle = 'neon'
    document.body.dataset.dsBrandPreset = 'invalid'
    document.body.dataset.dsBrandLabelMode = 'invalid'
    document.body.dataset.dsBrandGreetingMode = 'invalid'
    document.body.dataset.dsBrandCustomName = '  执辔\nPro  '
    document.body.dataset.dsBrandCustomGreeting = '  破浪前行  '
    try {
      const snapshot = make().theme.getTheme()
      expect(snapshot.preference).toBe('system')
      expect(snapshot.style).toBe('antigravity')
      expect(snapshot.brand).toEqual({
        preset: 'reins',
        labelMode: 'bilingual',
        customName: '执辔 Pro',
        greetingMode: 'brand',
        customGreeting: '破浪前行',
        title: '执辔 Reins',
      })
    } finally {
      delete document.documentElement.dataset.dsThemeSource
      delete document.body.dataset.dsThemeStyle
      delete document.body.dataset.dsBrandPreset
      delete document.body.dataset.dsBrandLabelMode
      delete document.body.dataset.dsBrandGreetingMode
      delete document.body.dataset.dsBrandCustomName
      delete document.body.dataset.dsBrandCustomGreeting
    }
  })

  it('seeds the initial font size from the boot-script body variable, ignoring junk', () => {
    // The Host boot script writes the durable size on body before any plugin
    // runs; the first snapshot must match it so activation never flashes 14.
    document.body.style.setProperty('--dsh-content-font-size', '22px')
    try {
      expect(make().theme.getTheme().fontSizes.text).toBe(22)
      document.body.style.setProperty('--dsh-content-font-size', '23px')
      expect(make().theme.getTheme().fontSizes.text).toBe(14)
    } finally {
      document.body.style.removeProperty('--dsh-content-font-size')
    }
  })

  it.each([10, 22])('setFontSize(%i) switches, writes through the scope, and republishes; same value is a no-op', (fontSize) => {
    const { theme, events, host } = make()
    theme.setFontSize('text', fontSize)
    expect(theme.getTheme().fontSizes.text).toBe(fontSize)
    expect(host.set).toHaveBeenCalledWith('fontSize', fontSize)
    expect(events).toHaveLength(1)
    theme.setFontSize('text', fontSize)
    expect(events).toHaveLength(1)
    expect(host.set).toHaveBeenCalledOnce()
  })

  it('rejects out-of-range and fractional font sizes', () => {
    const { theme, events, host } = make()
    for (const px of [9, 23, 14.5, Number.NaN]) {
      expect(() => { theme.setFontSize('text', px) }).toThrow('outside 10..22')
    }
    expect(events).toHaveLength(0)
    expect(host.set).not.toHaveBeenCalled()
  })

  it('sets code and terminal sizes independently within their own ranges', () => {
    const { theme, host } = make()
    theme.setFontSize('code', 16)
    theme.setFontSize('terminal', 20)
    expect(theme.getTheme().fontSizes).toEqual({ text: 14, code: 16, terminal: 20 })
    expect(host.set).toHaveBeenCalledWith('codeFontSize', 16)
    expect(host.set).toHaveBeenCalledWith('terminalFontSize', 20)
    expect(() => { theme.setFontSize('code', 17) }).toThrow('code font size 17 is outside 10..16')
    expect(() => { theme.setFontSize('terminal', 9) }).toThrow('outside 10..20')
  })

  it('seeds code and terminal sizes from the boot-script body variables, ignoring junk', () => {
    document.body.style.setProperty('--dsh-code-font-size', '14px')
    document.body.style.setProperty('--dsh-terminal-font-size', '99px')
    try {
      expect(make().theme.getTheme().fontSizes).toEqual({ text: 14, code: 14, terminal: 13 })
    } finally {
      document.body.style.removeProperty('--dsh-code-font-size')
      document.body.style.removeProperty('--dsh-terminal-font-size')
    }
  })

  it('adopts a published Host font size without writing it back', () => {
    const { theme, events, host } = make()
    host.publish({ status: 'ready', value: { preference: 'system', style: 'craft', ...defaultBrandFields, fontSize: 12, codeFontSize: 15, terminalFontSize: 18, textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }, revision: 1, writable: true })
    expect(theme.getTheme().fontSizes).toEqual({ text: 12, code: 15, terminal: 18 })
    expect(events).toHaveLength(1)
    expect(host.set).not.toHaveBeenCalled()
  })

  it('seeds initial font lists from the boot-script body variables, normalizing them', () => {
    document.body.style.setProperty('--dsh-font-family-code', 'Iosevka')
    try {
      expect(make().theme.getTheme().fontFamilies).toEqual({ text: '', code: '"Iosevka"', terminal: '' })
    } finally {
      document.body.style.removeProperty('--dsh-font-family-code')
    }
  })

  it('setFontFamily normalizes, writes one role through the scope, and republishes; same list is a no-op', () => {
    const { theme, events, host } = make()
    theme.setFontFamily('terminal', ' MesloLGS NF ,monospace,, ')
    expect(theme.getTheme().fontFamilies).toEqual({ text: '', code: '', terminal: '"MesloLGS NF", monospace' })
    expect(host.set).toHaveBeenCalledWith('terminalFontFamily', '"MesloLGS NF", monospace')
    expect(events).toHaveLength(1)
    theme.setFontFamily('terminal', '"MesloLGS NF", monospace')
    expect(events).toHaveLength(1)
    theme.setFontFamily('terminal', ' , ')
    expect(theme.getTheme().fontFamilies.terminal).toBe('')
    expect(host.set).toHaveBeenLastCalledWith('terminalFontFamily', '')
  })

  it('adopts published Host font lists, normalizing hand-edited values, without writing them back', () => {
    const { theme, events, host } = make()
    host.publish({ status: 'ready', value: { preference: 'system', style: 'craft', ...defaultBrandFields, fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: 'Inter', codeFontFamily: '"Fira Code"', terminalFontFamily: '' }, revision: 1, writable: true })
    expect(theme.getTheme().fontFamilies).toEqual({ text: '"Inter"', code: '"Fira Code"', terminal: '' })
    expect(events).toHaveLength(1)
    host.publish({ value: { preference: 'system', style: 'craft', ...defaultBrandFields, fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: '"Inter"', codeFontFamily: 'Fira Code', terminalFontFamily: '' }, revision: 2 })
    expect(events).toHaveLength(1)
    expect(host.set).not.toHaveBeenCalled()
  })

  it('setTheme switches, writes through the scope, republishes, and keeps DOM untouched', () => {
    const { theme, events, host } = make()
    theme.setTheme('dark')
    expect(theme.getTheme().preference).toBe('dark')
    expect(theme.getTheme().active.colorScheme).toBe('dark')
    expect(host.set).toHaveBeenCalledWith('preference', 'dark')
    expect(events).toHaveLength(1)
    expect(events[0]).toBe(theme.getTheme())
    // The service never touches presentation state.
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    // Same-value set is a no-op (no extra event).
    theme.setTheme('dark')
    expect(events).toHaveLength(1)
    expect(host.set).toHaveBeenCalledOnce()
  })

  it('setStyle switches, writes through the scope, republishes, and rejects unsupported values', () => {
    const { theme, events, host } = make()
    theme.setStyle('aurora')
    expect(theme.getTheme().style).toBe('aurora')
    expect(host.set).toHaveBeenCalledWith('style', 'aurora')
    expect(events).toHaveLength(1)
    expect(document.body.dataset.dsThemeStyle).toBeUndefined()
    theme.setStyle('aurora')
    expect(events).toHaveLength(1)
    expect(host.set).toHaveBeenCalledOnce()
    expect(() => { theme.setStyle('neon' as never) }).toThrow('not supported')
  })

  it('adopts a published Host section without writing it back', () => {
    const { theme, events, host } = make()
    host.publish({ status: 'ready', value: { preference: 'dark', style: 'warm', ...defaultBrandFields, fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }, revision: 1, writable: true })
    expect(theme.getTheme().preference).toBe('dark')
    expect(theme.getTheme().style).toBe('warm')
    expect(events).toHaveLength(1)
    expect(host.set).not.toHaveBeenCalled()
    host.publish({ value: { preference: 'dark', style: 'warm', ...defaultBrandFields, fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }, revision: 2 })
    expect(events).toHaveLength(1)
    host.publish({ value: { preference: 'dark', style: 'classic', ...defaultBrandFields, fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }, revision: 3 })
    expect(theme.getTheme().style).toBe('classic')
    expect(events).toHaveLength(2)
  })

  it('switches, normalizes, and adopts brand presets, wordmark formats, and greetings', async () => {
    const { theme, events, host } = make()
    theme.setBrandPreset('loom')
    expect(theme.getTheme().brand.preset).toBe('loom')
    expect(theme.getTheme().brand.title).toBe('灵枢 Loom')
    expect(host.set).toHaveBeenCalledWith('brandPreset', 'loom')
    theme.setBrandPreset('loom')
    expect(events).toHaveLength(1)
    expect(() => { theme.setBrandPreset('invalid' as never) }).toThrow('not supported')

    theme.setBrandLabelMode('zh')
    expect(theme.getTheme().brand.title).toBe('灵枢')
    expect(host.set).toHaveBeenCalledWith('brandLabelMode', 'zh')
    theme.setBrandLabelMode('zh')
    expect(events).toHaveLength(2)
    theme.setBrandLabelMode('custom')
    expect(theme.getTheme().brand.title).toBe('灵枢 Loom')
    expect(() => { theme.setBrandLabelMode('invalid' as never) }).toThrow('not supported')

    theme.setCustomBrandName('  灵枢\tStudio  ')
    expect(theme.getTheme().brand.customName).toBe('灵枢 Studio')
    expect(theme.getTheme().brand.title).toBe('灵枢 Studio')
    expect(host.set).toHaveBeenCalledWith('customBrandName', '灵枢 Studio')
    theme.setCustomBrandName('灵枢 Studio')
    expect(events).toHaveLength(4)

    theme.setBrandGreetingMode('time')
    expect(theme.getTheme().brand.greetingMode).toBe('time')
    expect(host.set).toHaveBeenCalledWith('brandGreetingMode', 'time')
    theme.setBrandGreetingMode('time')
    expect(events).toHaveLength(5)
    expect(() => { theme.setBrandGreetingMode('invalid' as never) }).toThrow('not supported')

    theme.setCustomBrandGreeting('  经纬既定\n万象皆可编织  ')
    expect(theme.getTheme().brand.customGreeting).toBe('经纬既定 万象皆可编织')
    expect(host.set).toHaveBeenCalledWith('customBrandGreeting', '经纬既定 万象皆可编织')
    theme.setCustomBrandGreeting('经纬既定 万象皆可编织')
    expect(events).toHaveLength(6)
    await Promise.resolve()

    const baseSection: ThemeSettings = {
      preference: 'system', style: 'antigravity',
      brandPreset: 'loom', brandLabelMode: 'custom', customBrandName: '灵枢 Studio',
      brandGreetingMode: 'time', customBrandGreeting: '经纬既定 万象皆可编织',
      fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
      textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
    }
    host.publish({ status: 'ready', value: baseSection, revision: 1, writable: true })
    expect(events).toHaveLength(6)
    host.publish({ value: { ...baseSection, brandPreset: 'lumen' }, revision: 2 })
    expect(theme.getTheme().brand.preset).toBe('lumen')
    host.publish({ value: { ...baseSection, brandPreset: 'lumen', brandLabelMode: 'en' }, revision: 3 })
    expect(theme.getTheme().brand.title).toBe('Lumen')
    host.publish({ value: { ...baseSection, brandPreset: 'lumen', brandLabelMode: 'en', customBrandName: 'New' }, revision: 4 })
    expect(theme.getTheme().brand.customName).toBe('New')
    host.publish({ value: { ...baseSection, brandPreset: 'lumen', brandLabelMode: 'en', customBrandName: 'New', brandGreetingMode: 'custom' }, revision: 5 })
    expect(theme.getTheme().brand.greetingMode).toBe('custom')
    host.publish({ value: { ...baseSection, brandPreset: 'lumen', brandLabelMode: 'en', customBrandName: 'New', brandGreetingMode: 'custom', customBrandGreeting: '澄明' }, revision: 6 })
    expect(theme.getTheme().brand.customGreeting).toBe('澄明')
    expect(events).toHaveLength(11)
  })

  it('toggleColorScheme switches between light and dark when matchMedia is absent', () => {
    const { theme, host } = make()
    expect(theme.getTheme().active.colorScheme).toBe('light')
    theme.toggleColorScheme()
    expect(theme.getTheme().preference).toBe('dark')
    expect(host.set).toHaveBeenLastCalledWith('preference', 'dark')
    theme.toggleColorScheme()
    expect(theme.getTheme().preference).toBe('light')
    expect(host.set).toHaveBeenLastCalledWith('preference', 'light')
  })

  it('holds its own changes while writes are pending, then converges on the durable section', async () => {
    const { theme, host } = make()
    const section = { preference: 'system' as const, style: 'craft' as const, ...defaultBrandFields, fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }
    host.publish({ status: 'ready', value: section, revision: 1, writable: true })
    const write = Promise.withResolvers<boolean>()
    host.set.mockReturnValue(write.promise)
    theme.setFontSize('code', 13)
    // A Host echo of an earlier write must not revert the pending local change.
    host.publish({ value: { ...section, terminalFontSize: 15 }, revision: 2 })
    expect(theme.getTheme().fontSizes).toEqual({ text: 14, code: 13, terminal: 13 })
    host.publish({ value: { ...section, codeFontSize: 13, terminalFontSize: 15 }, revision: 3 })
    write.resolve(true)
    await vi.waitFor(() => { expect(theme.getTheme().fontSizes).toEqual({ text: 14, code: 13, terminal: 15 }) })
  })

  it('adopts a section already standing at construction', () => {
    const host = stubConfigForm<ThemeSettings>()
    host.publish({ status: 'ready', value: { preference: 'dark', style: 'aurora', ...defaultBrandFields, fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }, revision: 1, writable: true })
    const { theme } = make(host)
    expect(theme.getTheme().preference).toBe('dark')
    expect(theme.getTheme().style).toBe('aurora')
  })

  it('throws on unknown setTheme ids, duplicate registration, and the system id', () => {
    const { theme } = make()
    expect(() => { theme.setTheme('sepia') }).toThrow('not registered')
    expect(() => theme.register({ id: 'light', colorScheme: 'light', tokens: {} })).toThrow('already registered')
    expect(() => theme.register({ id: 'system', colorScheme: 'light', tokens: {} })).toThrow('preference')
  })

  it('registered themes join the snapshot; disposing the active one resets to default', () => {
    const { theme, events, host } = make()
    const dispose = theme.register({ id: 'sepia', colorScheme: 'light', tokens: { '--dsw-alias-bg-base': 'red' } })
    expect(theme.getTheme().themes.map(t => t.id)).toEqual(['light', 'dark', 'sepia'])
    theme.setTheme('sepia')
    expect(theme.getTheme().active.tokens['--dsw-alias-bg-base']).toBe('red')
    dispose()
    expect(theme.getTheme().preference).toBe('system')
    expect(theme.getTheme().themes.map(t => t.id)).toEqual(['light', 'dark'])
    // Custom ids are in-process extension themes; only the built-in product
    // preferences cross the Host settings schema.
    expect(host.set).not.toHaveBeenCalled()
    // register + set + dispose = three publishes; disposer is idempotent.
    expect(events.length).toBe(3)
    dispose()
    expect(events.length).toBe(3)
  })

  it('disposing an inactive theme keeps the active preference', () => {
    const { theme } = make()
    const dispose = theme.register({ id: 'sepia', colorScheme: 'light', tokens: {} })
    theme.setTheme('dark')
    dispose()
    expect(theme.getTheme().preference).toBe('dark')
  })

  it('revision increases monotonically across every publish', () => {
    const { theme, events } = make()
    theme.setTheme('dark')
    theme.setTheme('light')
    const dispose = theme.register({ id: 'sepia', colorScheme: 'dark', tokens: {} })
    dispose()
    expect(events.map(e => e.revision)).toEqual([1, 2, 3, 4])
  })

  it('stacks reversible token overrides in call order and selects the active palette value', () => {
    const { theme } = make()
    const firstTokens: ThemeTokenOverrides = {
      '--shared': { light: 'first-light', dark: 'first-dark' },
      '--first': { light: 'first-only-light', dark: 'first-only-dark' },
    }
    const disposeFirst = theme.overrideTokens('first', firstTokens)
    firstTokens['--shared']!.light = 'mutated-after-call'
    const disposeSecond = theme.overrideTokens('second', {
      '--shared': { light: 'second-light', dark: 'second-dark' },
    })

    expect(theme.getTheme().active.tokens).toMatchObject({
      '--first': 'first-only-light',
      '--shared': 'second-light',
    })
    theme.setTheme('dark')
    expect(theme.getTheme().active.tokens).toMatchObject({
      '--first': 'first-only-dark',
      '--shared': 'second-dark',
    })

    disposeSecond()
    expect(theme.getTheme().active.tokens['--shared']).toBe('first-dark')
    disposeFirst()
    expect(theme.getTheme().active.tokens['--shared']).toBeUndefined()
  })

  it('replacing one source leaves its stale disposer harmless', () => {
    const { theme, events } = make()
    const stale = theme.overrideTokens('package', {
      '--old': { light: 'old-light', dark: 'old-dark' },
    })
    const current = theme.overrideTokens('package', {
      '--new': { light: 'new-light', dark: 'new-dark' },
    })
    stale()
    expect(theme.getTheme().active.tokens).toEqual({ '--new': 'new-light' })
    current()
    current()
    expect(theme.getTheme().active.tokens).toEqual({})
    expect(events).toHaveLength(3)
  })

  it('exports sorted built-in, registered, and override-only token descriptions as copies', () => {
    const { theme } = make()
    theme.register({
      id: 'custom',
      colorScheme: 'light',
      tokens: {
        '--dsw-alias-bg-base': 'duplicate-built-in',
        '--registered': 'registered',
      },
    })
    theme.overrideTokens('package', {
      '--registered': { light: 'duplicate-registered', dark: 'duplicate-registered' },
      semanticAccent: { light: 'pink', dark: 'red' },
    })

    const tokens = theme.exportInspectTokens()
    expect(tokens.map(token => token.name)).toEqual([...tokens.map(token => token.name)].sort())
    expect(tokens.find(token => token.name === '--registered')).toMatchObject({
      valueType: 'CSS value',
      cssVariable: '--registered',
    })
    const semantic = tokens.find(token => token.name === 'semanticAccent')
    expect(semantic).toMatchObject({ valueType: 'CSS value' })
    expect(semantic).not.toHaveProperty('cssVariable')
    expect(tokens.filter(token => token.name === '--dsw-alias-bg-base')).toHaveLength(1)

    tokens[0]!.description = 'caller mutation'
    expect(theme.exportInspectTokens()[0]!.description).not.toBe('caller mutation')
  })

  it('rejects every malformed token override value with a teaching error', () => {
    const { theme } = make()
    const override = (value: unknown): void => {
      theme.overrideTokens('package', { '--bad': value } as unknown as ThemeTokenOverrides)
    }
    expect(() => { override('red') }).toThrow(/bare string.*light.*dark/)
    for (const value of [1, null, {}, { light: 1, dark: 'dark' }, { light: 'light' }]) {
      expect(() => { override(value) }).toThrow(/must map to a \{ light, dark \} pair/)
    }
  })

  it('context dispose releases the scope subscription', async () => {
    const { ctx, host } = make()
    expect(host.listenerCount()).toBe(1)
    await ctx.fiber.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  describe('prefers-color-scheme resolution (stubbed matchMedia)', () => {
    type Listener = () => void
    const stubMedia = (initialMatches: boolean) => {
      const listeners = new Set<Listener>()
      const media = {
        matches: initialMatches,
        addEventListener: (_: 'change', fn: Listener) => { listeners.add(fn) },
        removeEventListener: (_: 'change', fn: Listener) => { listeners.delete(fn) },
        flip() {
          this.matches = !this.matches
          for (const fn of listeners) fn()
        },
        listenerCount: () => listeners.size,
      }
      vi.stubGlobal('matchMedia', () => media)
      return media
    }

    afterEach(() => { vi.unstubAllGlobals() })

    it('system resolves against the media query and follows OS flips', () => {
      const media = stubMedia(true)
      const { theme, events } = make()
      expect(theme.getTheme().preference).toBe('system')
      expect(theme.getTheme().active.id).toBe('dark')
      media.flip()
      expect(theme.getTheme().active.id).toBe('light')
      expect(events).toHaveLength(1)
    })

    it('OS flips do not republish while a concrete preference is set', () => {
      const media = stubMedia(false)
      const { theme, events } = make()
      theme.setTheme('light')
      expect(events).toHaveLength(1)
      media.flip()
      expect(events).toHaveLength(1)
      expect(theme.getTheme().active.id).toBe('light')
    })

    it('context dispose releases the media listener', async () => {
      const media = stubMedia(false)
      const { ctx } = make()
      expect(media.listenerCount()).toBe(1)
      await ctx.fiber.dispose()
      expect(media.listenerCount()).toBe(0)
    })

    it('toggleColorScheme pins the opposite scheme and reverts to system when matching OS preference', () => {
      stubMedia(true)
      const darkOs = make()
      expect(darkOs.theme.getTheme().active.colorScheme).toBe('dark')
      darkOs.theme.toggleColorScheme()
      expect(darkOs.theme.getTheme().preference).toBe('light')
      darkOs.theme.toggleColorScheme()
      expect(darkOs.theme.getTheme().preference).toBe('system')
      expect(darkOs.theme.getTheme().active.colorScheme).toBe('dark')

      stubMedia(false)
      const lightOs = make()
      expect(lightOs.theme.getTheme().active.colorScheme).toBe('light')
      lightOs.theme.toggleColorScheme()
      expect(lightOs.theme.getTheme().preference).toBe('dark')
      lightOs.theme.toggleColorScheme()
      expect(lightOs.theme.getTheme().preference).toBe('system')
      expect(lightOs.theme.getTheme().active.colorScheme).toBe('light')
    })
  })
})
