// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { allowAllAccess, contextMenuHook, makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel, type GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { ThemeRuntime, type ThemeSettings, type ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { createBrandSnapshot } from '@deepseek-ai/dsh-client-ui-theme/src/theme-settings.ts'
import {
  AboutBrandSection, BRAND_SETTINGS_NS, BrandSculptureMark, CUSTOM_EDITION_VERSION,
  HeroBrandHeadline, HeroBrandMark, OfficialBrandMark, OfficialBrandName,
  apply, inject, resolveBrandMottoKey, resolveHeroHeadlineText, resolveTimeGreetingKey,
  type AboutBrandSectionInjected, type BrandSlotInjected,
} from '../src/client/index.ts'
import { zh, type BrandLocaleKey } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'conversation.hero.frame',
  'conversation.hero.brand.mark',
  'conversation.hero.brand.headline',
  'settings.section',
] as const

const unused = (): never => { throw new Error('Brand surfaces do not read global session hooks') }
const globals: GlobalStandardProps = {
  usePanelInfo: unused,
  useSessions: unused,
  useSessionStatus: unused,
  useSessionRetainInfo: unused,
  useResource: unused,
  useWorkspaces: unused,
  ...allowAllAccess,
  useContextMenu: contextMenuHook(),
}

function makeSnapshot(overrides: Partial<ThemeSnapshot['brand']> = {}): ThemeSnapshot {
  const brand = createBrandSnapshot({
    preset: overrides.preset ?? 'reins',
    labelMode: overrides.labelMode ?? 'bilingual',
    customName: overrides.customName ?? '',
    greetingMode: overrides.greetingMode ?? 'brand',
    customGreeting: overrides.customGreeting ?? '',
  })
  return {
    preference: 'system',
    style: 'antigravity',
    brand,
    fontSizes: { text: 14, code: 11, terminal: 13 },
    fontFamilies: { text: '', code: '', terminal: '' },
    active: { id: 'light', colorScheme: 'light', tokens: {} },
    themes: [],
    revision: 0,
  }
}

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const host = stubConfigForm<ThemeSettings>()
  const theme = new ThemeRuntime(ctx, host.scope)
  ctx.provide('theme', theme)
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, {
      kind: name === 'conversation.hero.frame'
        ? 'hoc'
        : name === 'settings.section'
          ? 'list'
          : 'single',
      scope: 'root',
    }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, locale, theme, host, declareHoles, disposeHoles }
}

describe('brand customization and attribution plugin', () => {
  it('keeps the host Loader entry inert and declares required client services', () => {
    expect(hostApply).not.toThrow()
    expect(inject).toEqual(['slots', 'theme', 'locale'])
    expect(CUSTOM_EDITION_VERSION).toBe('v1.0.0')
  })

  it('fills sidebar, Hero, and Settings slots across local and official builds and tears down cleanly', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'local')
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)

    const [whaleEntry] = subject.slots.entries('conversation.hero.frame')
    expect(whaleEntry?.options.id).toBe('pixel-whale')

    const [markEntry] = subject.slots.entries('sidebar.brand.mark')
    const markFace = (markEntry!.inject!() as object) as BrandSlotInjected
    expect(markFace.hooks.theme.getSnapshot().brand.title).toBe('执辔 Reins')
    const onTheme = vi.fn()
    const offTheme = markFace.hooks.theme.subscribe(onTheme)
    subject.theme.setBrandPreset('loom')
    expect(onTheme).toHaveBeenCalledOnce()
    offTheme()

    const [aboutEntry] = subject.slots.entries('settings.section')
    expect(aboutEntry?.options.id).toBe('about')
    expect(aboutEntry?.locale).toBe(BRAND_SETTINGS_NS)
    expect(resolveSlotLabel(aboutEntry!.options.label)).toBe('关于与品牌')

    const aboutFace = (aboutEntry!.inject!() as object) as AboutBrandSectionInjected
    aboutFace.setBrandPreset('lumen')
    expect(subject.theme.getTheme().brand.preset).toBe('lumen')
    aboutFace.setBrandLabelMode('custom')
    aboutFace.setCustomBrandName('澄明 Studio')
    expect(subject.theme.getTheme().brand.title).toBe('澄明 Studio')
    aboutFace.setBrandGreetingMode('custom')
    aboutFace.setCustomBrandGreeting('澄明致远')
    expect(subject.theme.getTheme().brand.customGreeting).toBe('澄明致远')

    subject.disposeHoles?.()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
    subject.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)

    await fiber.dispose()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)

    const late = await bench(false)
    await late.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(late.slots.entries(hole)).toHaveLength(0)
    late.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(late.slots.entries(hole)).toHaveLength(1)
  })

  it('renders all four brand sculptures and sidebar/Hero occupants across presets and build profiles', () => {
    for (const preset of ['reins', 'loom', 'lumen', 'deepseek'] as const) {
      const sculpture = render(<BrandSculptureMark preset={preset} size={28} hovering={preset === 'reins'} />)
      const wrapper = sculpture.container.querySelector(`[data-brand-mark="${preset}"]`)
      expect(wrapper).not.toBeNull()
      expect(sculpture.container.querySelector('svg')?.getAttribute('width')).toBe('28')
      sculpture.unmount()
    }

    let current = makeSnapshot({ preset: 'reins' })
    const useTheme = <T,>(select: (s: ThemeSnapshot) => T): T => select(current)
    const t = makeTranslate(zh)

    const sidebarMark = render(<OfficialBrandMark {...globals} size={24} useTheme={useTheme} />)
    expect(sidebarMark.container.querySelector('[data-brand-mark="reins"]')).not.toBeNull()
    sidebarMark.unmount()

    const heroMark = render(<HeroBrandMark {...globals} size={34} className="hero" hovering useTheme={useTheme} />)
    expect(heroMark.container.querySelector('[data-brand-mark="reins"]')).not.toBeNull()
    heroMark.unmount()

    const heroHeadline = render(<HeroBrandHeadline {...globals} useTheme={useTheme} t={t} />)
    expect(heroHeadline.container.textContent).toBe(zh['preset.reins.motto'])
    heroHeadline.unmount()

    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'local')
    const sidebarName = render(<OfficialBrandName {...globals} useTheme={useTheme} />)
    expect(sidebarName.container.textContent).toBe('执辔 Reins')

    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    current = makeSnapshot({ preset: 'deepseek', labelMode: 'bilingual' })
    sidebarName.rerender(<OfficialBrandName {...globals} useTheme={useTheme} />)
    expect(sidebarName.container.querySelector('svg')?.getAttribute('viewBox')).toBe('26 0 156 24')

    current = makeSnapshot({ preset: 'deepseek', labelMode: 'custom', customName: 'DeepSeek Custom' })
    sidebarName.rerender(<OfficialBrandName {...globals} useTheme={useTheme} />)
    expect(sidebarName.container.textContent).toBe('DeepSeek Custom')
    sidebarName.unmount()
  })

  it('resolves time greetings and Hero headlines across every mode and fallback', () => {
    expect(resolveTimeGreetingKey(8)).toBe('greeting.morning')
    expect(resolveTimeGreetingKey(14)).toBe('greeting.afternoon')
    expect(resolveTimeGreetingKey(20)).toBe('greeting.evening')
    expect(resolveTimeGreetingKey(23)).toBe('greeting.night')
    expect(resolveTimeGreetingKey(2)).toBe('greeting.night')

    expect(resolveBrandMottoKey('reins')).toBe('preset.reins.motto')
    expect(resolveBrandMottoKey('loom')).toBe('preset.loom.motto')
    expect(resolveBrandMottoKey('lumen')).toBe('preset.lumen.motto')
    expect(resolveBrandMottoKey('deepseek')).toBe('preset.deepseek.motto')

    const t = (key: BrandLocaleKey) => zh[key]
    expect(resolveHeroHeadlineText({ preset: 'loom', greetingMode: 'brand', customGreeting: '', t })).toBe(zh['preset.loom.motto'])
    expect(resolveHeroHeadlineText({ preset: 'loom', greetingMode: 'custom', customGreeting: '自定义欢迎词', t })).toBe('自定义欢迎词')
    expect(resolveHeroHeadlineText({ preset: 'lumen', greetingMode: 'custom', customGreeting: '', t })).toBe(zh['preset.lumen.motto'])
    expect(resolveHeroHeadlineText({ preset: 'reins', greetingMode: 'time', customGreeting: '', hour: 9, t })).toBe(zh['greeting.morning'])
    expect(resolveHeroHeadlineText({ preset: 'reins', greetingMode: 'time', customGreeting: '', t })).toBeTruthy()
  })

  it('renders AboutBrandSection with engine attribution, clipboard feedback, hover states, and custom inputs', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    try {
      let current = makeSnapshot({ preset: 'reins', labelMode: 'custom', customName: '执辔 Pro', greetingMode: 'custom', customGreeting: '驭算随心' })
      const setBrandPreset = vi.fn()
      const setBrandLabelMode = vi.fn()
      const setCustomBrandName = vi.fn()
      const setBrandGreetingMode = vi.fn()
      const setCustomBrandGreeting = vi.fn()
      const t = makeTranslate(zh)

      const renderSection = () => (
        <AboutBrandSection
          {...globals}
          close={() => {}}
          t={t}
          useTheme={select => select(current)}
          setBrandPreset={setBrandPreset}
          setBrandLabelMode={setBrandLabelMode}
          setCustomBrandName={setCustomBrandName}
          setBrandGreetingMode={setBrandGreetingMode}
          setCustomBrandGreeting={setCustomBrandGreeting}
        />
      )

      vi.stubEnv('DSH_CLIENT_VERSION', '')
      Reflect.deleteProperty(process.env, 'DSH_CLIENT_VERSION')
      Reflect.deleteProperty(process.env, 'DSH_CLIENT_COMMIT_HASH')
      Reflect.deleteProperty(process.env, 'DSH_CLIENT_GIT_DIRTY')

      const view = render(renderSection())
      expect(screen.getAllByText(zh.localDevFallback)).toHaveLength(2)

      vi.stubEnv('DSH_CLIENT_VERSION', '0.2.2-rc.2')
      vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '1234567')
      vi.stubEnv('DSH_CLIENT_GIT_DIRTY', 'false')
      view.rerender(renderSection())
      expect(screen.getByText('0.2.2-rc.2')).toBeTruthy()
      expect(screen.getByText('1234567')).toBeTruthy()

      vi.stubEnv('DSH_CLIENT_GIT_DIRTY', 'true')
      view.rerender(renderSection())
      expect(screen.getByText('1234567-dirty')).toBeTruthy()

      // Hover interactions across the attribution card and preset gallery cards.
      const region = screen.getByRole('region', { name: zh.nav })
      const attributionCard = region.firstElementChild as HTMLElement
      const loomButton = screen.getByRole('button', { name: new RegExp(zh['preset.loom.name']) })

      fireEvent.pointerEnter(attributionCard)
      fireEvent.pointerLeave(loomButton)
      fireEvent.pointerLeave(attributionCard)
      fireEvent.pointerEnter(loomButton)
      fireEvent.pointerLeave(attributionCard)
      fireEvent.pointerLeave(loomButton)
      fireEvent.click(loomButton)
      expect(setBrandPreset).toHaveBeenCalledWith('loom')

      // Custom wordmark and custom greeting inputs.
      fireEvent.change(screen.getByLabelText(zh.customNameAria), { target: { value: '灵枢 OS' } })
      expect(setCustomBrandName).toHaveBeenCalledWith('灵枢 OS')
      fireEvent.change(screen.getByLabelText(zh.customGreetingAria), { target: { value: '经纬既定' } })
      expect(setCustomBrandGreeting).toHaveBeenCalledWith('经纬既定')

      // Non-custom modes omit the text inputs while keeping live preview chips.
      current = makeSnapshot({ preset: 'reins', labelMode: 'bilingual', greetingMode: 'brand' })
      view.rerender(renderSection())
      expect(screen.queryByLabelText(zh.customNameAria)).toBeNull()
      expect(screen.queryByLabelText(zh.customGreetingAria)).toBeNull()

      // Copy diagnostics: success, immediate repeat (\u00A0), timer reset, failure, and unmount cleanup.
      const copyBtn = screen.getByRole('button', { name: zh.copyDiagnostics })
      await act(async () => { fireEvent.click(copyBtn) })
      expect(writeText).toHaveBeenCalledOnce()
      expect(writeText.mock.calls[0]?.[0]).toContain('执辔 Reins v1.0.0')
      expect(writeText.mock.calls[0]?.[0]).toContain('DSH Core: 0.2.2-rc.2')
      expect(writeText.mock.calls[0]?.[0]).toContain('Commit: 1234567-dirty')
      expect(screen.getByRole('status').textContent).toBe(zh.copied)

      await act(async () => { fireEvent.click(copyBtn) })
      expect(screen.getByRole('status').textContent).toBe(`${zh.copied}\u00A0`)

      act(() => { vi.advanceTimersByTime(1_800) })
      expect(screen.getByRole('status').textContent).toBe('')

      writeText.mockRejectedValueOnce(new Error('denied'))
      await act(async () => { fireEvent.click(copyBtn) })
      expect(screen.getByRole('status').textContent).toBe(zh.copyFailed)
      view.unmount()

      const idleView = render(renderSection())
      idleView.unmount()
    } finally {
      if (originalClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', originalClipboard)
    }
  })
})
