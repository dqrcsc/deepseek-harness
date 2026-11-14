/** Host registration for the browser theme preference and pre-plugin palette. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'
import type { BrandGreetingMode, BrandLabelMode, BrandPreset, ThemePreference, ThemeStyle } from './theme-settings.ts'
import z from '@deepseek-ai/schemastery'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { bootThemeInjections } from './boot-theme.ts'
import {
  BRAND_GREETING_MODES, BRAND_PRESETS, BRAND_WORDMARK_MODES, createBrandSnapshot,
  DEFAULT_BRAND_GREETING_MODE, DEFAULT_BRAND_PRESET, DEFAULT_BRAND_WORDMARK_MODE,
  DEFAULT_PREFERENCE, DEFAULT_THEME_STYLE, FONT_SIZE_SPECS, fontSizeSchema, THEME_PREFERENCES, THEME_STYLES,
} from './theme-settings.ts'

export {
  BRAND_GREETING_MODES, BRAND_PRESETS, BRAND_WORDMARK_MODES, CUSTOM_EDITION_VERSION,
  DEFAULT_BRAND_GREETING_MODE, DEFAULT_BRAND_PRESET, DEFAULT_BRAND_SNAPSHOT, DEFAULT_BRAND_WORDMARK_MODE,
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, FONT_SIZE_FIELD, FONT_SIZE_MAX, FONT_SIZE_MIN,
  THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE,
  type BrandGreetingMode, type BrandLabelMode, type BrandPreferences, type BrandPreset, type BrandSnapshot,
  type ThemePreference, type ThemeSettings, type ThemeStyle,
} from './theme-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Browser palette preference. */
  preference: Volatile<ThemePreference>
  /** Visual theme style across light and dark palettes. */
  style: Volatile<ThemeStyle>
  /** Selected brand identity preset. */
  brandPreset: Volatile<BrandPreset>
  /** Selected brand wordmark display format. */
  brandLabelMode: Volatile<BrandLabelMode>
  /** Custom brand wordmark text; `''` uses the preset bilingual title. */
  customBrandName: Volatile<string>
  /** Selected Hero welcome headline mode. */
  brandGreetingMode: Volatile<BrandGreetingMode>
  /** Custom Hero welcome headline text; `''` uses the preset motto. */
  customBrandGreeting: Volatile<string>
  /** Browser font size in pixels. */
  fontSize: Volatile<number>
  /** Code-block font size in pixels. */
  codeFontSize: Volatile<number>
  /** Sidebar terminal font size in pixels. */
  terminalFontSize: Volatile<number>
  /** Interface and body text font list; `''` keeps the built-in stack. */
  textFontFamily: Volatile<string>
  /** Code font list; `''` keeps the built-in stack. */
  codeFontFamily: Volatile<string>
  /** Sidebar terminal font list; `''` keeps the built-in stack. */
  terminalFontFamily: Volatile<string>
}

/** Live theme and typography preferences. */
export const Config = z.object({
  preference: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE).volatile(),
  style: z.union([...THEME_STYLES]).default(DEFAULT_THEME_STYLE).volatile(),
  brandPreset: z.union([...BRAND_PRESETS]).default(DEFAULT_BRAND_PRESET).volatile(),
  brandLabelMode: z.union([...BRAND_WORDMARK_MODES]).default(DEFAULT_BRAND_WORDMARK_MODE).volatile(),
  customBrandName: z.string().default('').volatile(),
  brandGreetingMode: z.union([...BRAND_GREETING_MODES]).default(DEFAULT_BRAND_GREETING_MODE).volatile(),
  customBrandGreeting: z.string().default('').volatile(),
  fontSize: fontSizeSchema(FONT_SIZE_SPECS.text).volatile(),
  codeFontSize: fontSizeSchema(FONT_SIZE_SPECS.code).volatile(),
  terminalFontSize: fontSizeSchema(FONT_SIZE_SPECS.terminal).volatile(),
  textFontFamily: z.string().default('').volatile(),
  codeFontFamily: z.string().default('').volatile(),
  terminalFontFamily: z.string().default('').volatile(),
})

/** Supply the current palette before browser plugins start.
 * @param ctx Host plugin context.
 * @param config Validated live theme preferences.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.on('webserver/index-inject', (table) => {
    table.push(...bootThemeInjections(config.preference.get(), {
      text: config.fontSize.get(),
      code: config.codeFontSize.get(),
      terminal: config.terminalFontSize.get(),
    }, {
      text: config.textFontFamily.get(),
      code: config.codeFontFamily.get(),
      terminal: config.terminalFontFamily.get(),
    }, config.style.get(), createBrandSnapshot({
      preset: config.brandPreset.get(),
      labelMode: config.brandLabelMode.get(),
      customName: config.customBrandName.get(),
      greetingMode: config.brandGreetingMode.get(),
      customGreeting: config.customBrandGreeting.get(),
    })))
  }, { prepend: true })
}
