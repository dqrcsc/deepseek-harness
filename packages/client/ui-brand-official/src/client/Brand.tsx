/** Sidebar and home Hero brand slot occupants backed by the active ThemeRuntime brand snapshot. */
import { BrandWordmark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BrandGreetingMode, BrandPreset, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { BrandSculptureMark } from './BrandArtwork.tsx'
import type { BrandLocaleKey } from './locales.ts'
import css from './Brand.module.css'

/** Reactive theme hook face shared by the brand slot occupants. */
export interface BrandSlotInjected {
  /** Observable theme state carrying the active brand configuration. */
  hooks: {
    theme: HostObservable<ThemeSnapshot>
  }
}

/**
 * Resolve the localized time-of-day greeting key for a 24-hour clock hour.
 * @param hour - Local hour from `0` through `23`.
 * @returns Matching greeting locale key.
 */
export function resolveTimeGreetingKey(hour: number): BrandLocaleKey {
  if (hour >= 5 && hour < 12) return 'greeting.morning'
  if (hour >= 12 && hour < 18) return 'greeting.afternoon'
  if (hour >= 18 && hour < 23) return 'greeting.evening'
  return 'greeting.night'
}

/**
 * Resolve the localized motto key for a built-in brand preset.
 * @param preset - Active brand preset id.
 * @returns Matching motto locale key.
 */
export function resolveBrandMottoKey(preset: BrandPreset): BrandLocaleKey {
  if (preset === 'loom') return 'preset.loom.motto'
  if (preset === 'lumen') return 'preset.lumen.motto'
  if (preset === 'deepseek') return 'preset.deepseek.motto'
  return 'preset.reins.motto'
}

/**
 * Resolve the Hero welcome headline from the active brand configuration and clock hour.
 * @param params - Active preset, greeting mode, custom greeting text, local hour, and translator.
 * @returns Resolved Hero headline text.
 */
export function resolveHeroHeadlineText(params: {
  readonly preset: BrandPreset
  readonly greetingMode: BrandGreetingMode
  readonly customGreeting: string
  readonly t: (key: BrandLocaleKey) => string
  readonly hour?: number | undefined
}): string {
  const { preset, greetingMode, customGreeting, t, hour = new Date().getHours() } = params
  if (greetingMode === 'custom' && customGreeting !== '') return customGreeting
  if (greetingMode === 'time') return t(resolveTimeGreetingKey(hour))
  return t(resolveBrandMottoKey(preset))
}

/**
 * Render the sidebar brand mark with the active sculpted emblem.
 * @param props - Sidebar mark size and reactive theme hook.
 * @returns Sculpted mark element.
 */
export function OfficialBrandMark({
  size,
  useTheme,
}: PropsRuntime<'sidebar.brand.mark'> & InjectFace<BrandSlotInjected>) {
  const preset = useTheme(snapshot => snapshot.brand.preset)
  return <BrandSculptureMark preset={preset} size={size} />
}

/**
 * Render the sidebar brand wordmark without any local-build version badge.
 * @param props - Reactive theme hook.
 * @returns Official vector wordmark on official DeepSeek preset, or clean typography wordmark.
 */
export function OfficialBrandName({
  useTheme,
}: PropsRuntime<'sidebar.brand.name'> & InjectFace<BrandSlotInjected>) {
  const preset = useTheme(snapshot => snapshot.brand.preset)
  const labelMode = useTheme(snapshot => snapshot.brand.labelMode)
  const title = useTheme(snapshot => snapshot.brand.title)
  if (preset === 'deepseek' && labelMode !== 'custom' && process.env.DSH_CLIENT_BUILD_PROFILE === 'official') {
    return <BrandWordmark includeMark={false} />
  }
  return (
    <span className={css.wordmark} data-brand-preset={preset}>
      {title}
    </span>
  )
}

/**
 * Render the empty-conversation Hero emblem with subtle hover elevation.
 * @param props - Hero mark size, hover state, and reactive theme hook.
 * @returns Sculpted Hero mark element.
 */
export function HeroBrandMark({
  size,
  hovering,
  useTheme,
}: PropsRuntime<'conversation.hero.brand.mark'> & InjectFace<BrandSlotInjected>) {
  const preset = useTheme(snapshot => snapshot.brand.preset)
  return <BrandSculptureMark preset={preset} size={size} hovering={hovering} />
}

/**
 * Render the empty-conversation Hero welcome headline without a preview badge.
 * @param props - Localized translator and reactive theme hook.
 * @returns Hero headline span.
 */
export function HeroBrandHeadline({
  useTheme,
  t,
}: PropsRuntime<'conversation.hero.brand.headline'> & PropsLocale<'settings.brand'> & InjectFace<BrandSlotInjected>) {
  const preset = useTheme(snapshot => snapshot.brand.preset)
  const greetingMode = useTheme(snapshot => snapshot.brand.greetingMode)
  const customGreeting = useTheme(snapshot => snapshot.brand.customGreeting)
  return (
    <span className={css.heroHeadline}>
      {resolveHeroHeadlineText({ preset, greetingMode, customGreeting, t })}
    </span>
  )
}
