/** Brand customization and engine attribution occupants across the sidebar, home Hero, and Settings dialog. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { PixelWhale } from './home-whale/PixelWhale.tsx'
import {
  HeroBrandHeadline, HeroBrandMark, OfficialBrandMark, OfficialBrandName,
  type BrandSlotInjected,
} from './Brand.tsx'
import { AboutBrandSection, type AboutBrandSectionInjected } from './AboutBrandSection.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type BrandLocaleKey } from './locales.ts'

export {
  CUSTOM_EDITION_VERSION, BrandSculptureMark, resolveEditionVersion, type BrandSculptureMarkProps,
} from './BrandArtwork.tsx'
export {
  HeroBrandHeadline, HeroBrandMark, OfficialBrandMark, OfficialBrandName,
  resolveBrandMottoKey, resolveHeroHeadlineText, resolveTimeGreetingKey,
  type BrandSlotInjected,
} from './Brand.tsx'
export { AboutBrandSection, type AboutBrandSectionInjected, type AboutBrandSectionProps } from './AboutBrandSection.tsx'
export type { BrandLocaleKey } from './locales.ts'

/** Locale namespace owning the brand studio and attribution dictionaries. */
export const BRAND_SETTINGS_NS = 'settings.brand'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Brand studio and engine attribution copy. */
    'settings.brand': BrandLocaleKey
  }
}

/** Required services: slot registry, active theme runtime, and locale registry. */
export const inject = ['slots', 'theme', 'locale']

/**
 * Register sidebar and Hero brand artwork, Hero welcome motto, home whale background, and the About & Brand settings section.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(BRAND_SETTINGS_NS, { zh, en, ja, es, fr, de, ru, pt }),
    'ui-brand-official: brand and attribution dictionaries',
  )
  const t = ctx.locale.bind(BRAND_SETTINGS_NS)
  const themeHook = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: (listener: () => void) => ctx.on('theme/change', listener),
  }
  const slotInjected = (): BrandSlotInjected => ({ hooks: { theme: themeHook } })
  const sectionInjected = (): AboutBrandSectionInjected => ({
    hooks: { theme: themeHook },
    setBrandPreset: (preset) => { ctx.theme.setBrandPreset(preset) },
    setBrandLabelMode: (mode) => { ctx.theme.setBrandLabelMode(mode) },
    setCustomBrandName: (name) => { ctx.theme.setCustomBrandName(name) },
    setBrandGreetingMode: (mode) => { ctx.theme.setBrandGreetingMode(mode) },
    setCustomBrandGreeting: (greeting) => { ctx.theme.setCustomBrandGreeting(greeting) },
  })

  ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({
    name: 'conversation.hero.frame',
    id: 'pixel-whale',
  }, PixelWhale))

  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', inject: slotInjected }, OfficialBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', inject: slotInjected }, OfficialBrandName)
    }))

  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
    inject: slotInjected,
  }, HeroBrandMark))

  ctx.slots.inject('conversation.hero.brand.headline', () => ctx.slots.register({
    name: 'conversation.hero.brand.headline',
    locale: BRAND_SETTINGS_NS,
    inject: slotInjected,
  }, HeroBrandHeadline))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'about',
    order: 90,
    label: () => t('nav'),
    locale: BRAND_SETTINGS_NS,
    inject: sectionInjected,
  }, AboutBrandSection))
}
