/** Theme preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'
import { BRAND_PRESET_NAMES } from './locales/brand-names.ts'

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** Built-in visual styles orthogonal to the light/dark color scheme. */
export const THEME_STYLES = ['antigravity', 'codex', 'warm', 'linear', 'craft', 'aurora', 'nord', 'classic'] as const

/** Built-in brand identity presets selectable in Settings. */
export const BRAND_PRESETS = ['reins', 'loom', 'lumen', 'deepseek'] as const

/** Built-in wordmark display formats for brand presets. */
export const BRAND_WORDMARK_MODES = ['bilingual', 'zh', 'en', 'custom'] as const

/** Built-in Hero welcome headline modes. */
export const BRAND_GREETING_MODES = ['brand', 'time', 'custom'] as const

/** Custom edition release version shown in the About & Brand attribution card. */
export const CUSTOM_EDITION_VERSION = 'v1.0.0'

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the selected visual theme style. */
export const THEME_STYLE_FIELD = 'style'

/** Field carrying the selected brand preset. */
export const BRAND_PRESET_FIELD = 'brandPreset'

/** Field carrying the selected wordmark display format. */
export const BRAND_WORDMARK_MODE_FIELD = 'brandLabelMode'

/** Field carrying the user-defined custom brand wordmark. */
export const CUSTOM_BRAND_NAME_FIELD = 'customBrandName'

/** Field carrying the selected Hero welcome headline mode. */
export const BRAND_GREETING_MODE_FIELD = 'brandGreetingMode'

/** Field carrying the user-defined custom Hero welcome headline. */
export const CUSTOM_BRAND_GREETING_FIELD = 'customBrandGreeting'

/** Field carrying the conversation content font size. */
export const FONT_SIZE_FIELD = 'fontSize'

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** Visual theme style persisted by the product Appearance row. */
export type ThemeStyle = typeof THEME_STYLES[number]

/** Brand preset persisted by the About & Brand section. */
export type BrandPreset = typeof BRAND_PRESETS[number]

/** Wordmark display mode persisted by the About & Brand section. */
export type BrandLabelMode = typeof BRAND_WORDMARK_MODES[number]

/** Hero welcome headline mode persisted by the About & Brand section. */
export type BrandGreetingMode = typeof BRAND_GREETING_MODES[number]

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** Default visual theme style when the user-settings document has no override. */
export const DEFAULT_THEME_STYLE: ThemeStyle = 'antigravity'

/** Default out-of-the-box brand preset (`执辔 Reins`). */
export const DEFAULT_BRAND_PRESET: BrandPreset = 'reins'

/** Default wordmark display mode (`中英并列`). */
export const DEFAULT_BRAND_WORDMARK_MODE: BrandLabelMode = 'bilingual'

/** Default Hero headline mode (poetic brand motto). */
export const DEFAULT_BRAND_GREETING_MODE: BrandGreetingMode = 'brand'

/** Maximum normalized length for custom brand wordmarks. */
export const BRAND_NAME_MAX_LENGTH = 40

/** Maximum normalized length for custom Hero welcome headlines. */
export const BRAND_GREETING_MAX_LENGTH = 80

/** Smallest accepted content font size (px). */
export const FONT_SIZE_MIN = 10

/** Largest accepted content font size (px). */
export const FONT_SIZE_MAX = 22

/** Content font size when the user-settings document has no override (px). */
export const DEFAULT_FONT_SIZE = 14

/** Independently configurable font roles. */
export const FONT_ROLES = ['text', 'code', 'terminal'] as const

/** One configurable font role: interface text, code, or the sidebar terminal. */
export type FontRole = typeof FONT_ROLES[number]

/** Settings field, body variable, and accepted integer px range of one role's font size. */
export interface FontSizeSpec {
  /** Settings field carrying the size. */
  field: string
  /** Body variable carrying the size in px. */
  variable: string
  /** Smallest accepted size. */
  min: number
  /** Largest accepted size. */
  max: number
  /** Size when the user-settings document has no override. */
  default: number
}

/**
 * Font sizes by role. `text` is the conversation content size; `code` is the
 * code-block size (inline code stays 1px larger); `terminal` is the sidebar
 * terminal cell font size.
 */
export const FONT_SIZE_SPECS = {
  text: { field: FONT_SIZE_FIELD, variable: '--dsh-content-font-size', min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, default: DEFAULT_FONT_SIZE },
  code: { field: 'codeFontSize', variable: '--dsh-code-font-size', min: 10, max: 16, default: 11 },
  terminal: { field: 'terminalFontSize', variable: '--dsh-terminal-font-size', min: 10, max: 20, default: 13 },
} as const satisfies Record<FontRole, FontSizeSpec>

/** Integer px font sizes by role. */
export type FontSizes = Readonly<Record<FontRole, number>>

/** Default font sizes by role. */
export const DEFAULT_FONT_SIZES: FontSizes = Object.freeze({
  text: FONT_SIZE_SPECS.text.default, code: FONT_SIZE_SPECS.code.default, terminal: FONT_SIZE_SPECS.terminal.default,
})

/** Settings field carrying each role's font-family list. */
export const FONT_FAMILY_FIELDS = {
  text: 'textFontFamily',
  code: 'codeFontFamily',
  terminal: 'terminalFontFamily',
} as const satisfies Record<FontRole, string>

/**
 * Body variable carrying one role's normalized font list; the token sheet
 * places it ahead of that role's built-in stack.
 * @param kind - font role.
 * @returns the CSS custom property name.
 */
export function fontFamilyVariable(kind: FontRole): string {
  return `--dsh-font-family-${kind}`
}

/** Normalized CSS font-family lists by role; `''` selects the built-in stack. */
export type FontFamilies = Readonly<Record<FontRole, string>>

/** Durable brand configuration inputs shared across Host and browser. */
export interface BrandPreferences {
  /** Selected brand emblem and identity preset. */
  readonly preset: BrandPreset
  /** Selected wordmark format (`bilingual`, `zh`, `en`, or `custom`). */
  readonly labelMode: BrandLabelMode
  /** Normalized custom wordmark text when `labelMode` is `custom`. */
  readonly customName: string
  /** Selected Hero headline mode (`brand`, `time`, or `custom`). */
  readonly greetingMode: BrandGreetingMode
  /** Normalized custom Hero headline text when `greetingMode` is `custom`. */
  readonly customGreeting: string
}

/** Immutable brand state published on {@link ThemeSnapshot}, including the resolved display title. */
export interface BrandSnapshot extends BrandPreferences {
  /** Resolved product title for the sidebar wordmark and document title. */
  readonly title: string
}

/**
 * Normalize single-line user brand text by stripping control characters, collapsing
 * whitespace, trimming edges, and capping length.
 * @param value - raw user-entered or stored text.
 * @param maxLength - maximum character count to retain.
 * @returns normalized single-line text.
 */
export function normalizeBrandText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxLength)
}

/**
 * Resolve the visible product wordmark/title for a brand preference set.
 * @param brand - brand preset, wordmark mode, and custom wordmark text.
 * @returns resolved non-empty product title.
 */
export function resolveBrandTitle(brand: Pick<BrandPreferences, 'preset' | 'labelMode' | 'customName'>): string {
  if (brand.labelMode === 'custom') {
    const custom = normalizeBrandText(brand.customName, BRAND_NAME_MAX_LENGTH)
    if (custom !== '') return custom
    return BRAND_PRESET_NAMES[brand.preset].bilingual
  }
  return BRAND_PRESET_NAMES[brand.preset][brand.labelMode]
}

/**
 * Build a frozen {@link BrandSnapshot} with normalized text fields and resolved title.
 * @param brand - candidate brand preference fields.
 * @returns immutable brand snapshot.
 */
export function createBrandSnapshot(brand: BrandPreferences): BrandSnapshot {
  const customName = normalizeBrandText(brand.customName, BRAND_NAME_MAX_LENGTH)
  const customGreeting = normalizeBrandText(brand.customGreeting, BRAND_GREETING_MAX_LENGTH)
  const normalized: BrandPreferences = {
    preset: brand.preset,
    labelMode: brand.labelMode,
    customName,
    greetingMode: brand.greetingMode,
    customGreeting,
  }
  return Object.freeze({ ...normalized, title: resolveBrandTitle(normalized) })
}

/** Default immutable brand snapshot (`执辔 Reins`). */
export const DEFAULT_BRAND_SNAPSHOT: BrandSnapshot = createBrandSnapshot({
  preset: DEFAULT_BRAND_PRESET,
  labelMode: DEFAULT_BRAND_WORDMARK_MODE,
  customName: '',
  greetingMode: DEFAULT_BRAND_GREETING_MODE,
  customGreeting: '',
})

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /** Selected visual theme style across light and dark palettes. */
  style: ThemeStyle
  /** Selected brand identity preset. */
  brandPreset: BrandPreset
  /** Selected brand wordmark display format. */
  brandLabelMode: BrandLabelMode
  /** Custom brand wordmark text; `''` falls back to the preset's bilingual title. */
  customBrandName: string
  /** Selected Hero welcome headline mode. */
  brandGreetingMode: BrandGreetingMode
  /** Custom Hero welcome headline text; `''` falls back to the preset motto. */
  customBrandGreeting: string
  /** Conversation content font size in px (integer within {@link FONT_SIZE_MIN}..{@link FONT_SIZE_MAX}). */
  fontSize: number
  /** Code-block font size in px (integer within the {@link FONT_SIZE_SPECS} `code` range). */
  codeFontSize: number
  /** Sidebar terminal font size in px (integer within the {@link FONT_SIZE_SPECS} `terminal` range). */
  terminalFontSize: number
  /** Interface and body text fonts placed before the built-in stack; `''` keeps the built-in stack. */
  textFontFamily: string
  /** Code fonts placed before the built-in code stack; `''` keeps the built-in stack. */
  codeFontFamily: string
  /** Sidebar terminal fonts placed before the built-in terminal stack; `''` keeps the built-in stack. */
  terminalFontFamily: string
}

/**
 * Integer px schema for one role's font size.
 * @param spec - the role's range and default.
 * @returns the validated number schema.
 */
export function fontSizeSchema(spec: FontSizeSpec): z<number> {
  return z.number().step(1).min(spec.min).max(spec.max).default(spec.default)
}

/**
 * Collect every role's size from a settings section.
 * @param section - accepted theme settings.
 * @returns integer px sizes by role.
 */
export function sectionFontSizes(section: ThemeSettings): FontSizes {
  return Object.freeze({ text: section.fontSize, code: section.codeFontSize, terminal: section.terminalFontSize })
}

/**
 * Whether one value is an accepted size for a role.
 * @param role - font role.
 * @param px - candidate size.
 * @returns true for an integer within the role's range.
 */
export function isFontSize(role: FontRole, px: number): boolean {
  const spec = FONT_SIZE_SPECS[role]
  return Number.isInteger(px) && px >= spec.min && px <= spec.max
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [THEME_STYLE_FIELD]: z.union([...THEME_STYLES]).default(DEFAULT_THEME_STYLE),
  [BRAND_PRESET_FIELD]: z.union([...BRAND_PRESETS]).default(DEFAULT_BRAND_PRESET),
  [BRAND_WORDMARK_MODE_FIELD]: z.union([...BRAND_WORDMARK_MODES]).default(DEFAULT_BRAND_WORDMARK_MODE),
  [CUSTOM_BRAND_NAME_FIELD]: z.string().default(''),
  [BRAND_GREETING_MODE_FIELD]: z.union([...BRAND_GREETING_MODES]).default(DEFAULT_BRAND_GREETING_MODE),
  [CUSTOM_BRAND_GREETING_FIELD]: z.string().default(''),
  [FONT_SIZE_FIELD]: fontSizeSchema(FONT_SIZE_SPECS.text),
  [FONT_SIZE_SPECS.code.field]: fontSizeSchema(FONT_SIZE_SPECS.code),
  [FONT_SIZE_SPECS.terminal.field]: fontSizeSchema(FONT_SIZE_SPECS.terminal),
  [FONT_FAMILY_FIELDS.text]: z.string().default(''),
  [FONT_FAMILY_FIELDS.code]: z.string().default(''),
  [FONT_FAMILY_FIELDS.terminal]: z.string().default(''),
})

/** CSS Fonts generic and system family keywords, which must stay unquoted. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont',
])

/**
 * Normalize user input into a CSS font-family list. Names are comma separated;
 * quotes, backslashes, angle brackets, and control characters are dropped, and
 * every non-generic name is double-quoted, so the result is always a valid list
 * safe to embed in inline CSS and boot scripts. Normalizing a result returns it unchanged.
 * @param value - user-entered or stored font list.
 * @returns the normalized list, or `''` when no family name remains.
 */
export function normalizeFontFamily(value: string): string {
  return value.split(',')
    .map(name => name.replace(/["'\\<>\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim())
    .filter(name => name !== '')
    .map(name => GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name}"`)
    .join(', ')
}

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}

/**
 * Narrow one wire or boot value to a supported visual theme style.
 * @param value - value crossing the settings or boot boundary.
 * @returns whether the value is a built-in theme style.
 */
export function isThemeStyle(value: unknown): value is ThemeStyle {
  return THEME_STYLES.some(style => style === value)
}

/**
 * Narrow one wire or boot value to a supported brand preset.
 * @param value - value crossing the settings or boot boundary.
 * @returns whether the value is a built-in brand preset.
 */
export function isBrandPreset(value: unknown): value is BrandPreset {
  return BRAND_PRESETS.some(preset => preset === value)
}

/**
 * Narrow one wire or boot value to a supported brand wordmark display mode.
 * @param value - value crossing the settings or boot boundary.
 * @returns whether the value is a built-in brand label mode.
 */
export function isBrandLabelMode(value: unknown): value is BrandLabelMode {
  return BRAND_WORDMARK_MODES.some(mode => mode === value)
}

/**
 * Narrow one wire or boot value to a supported Hero welcome headline mode.
 * @param value - value crossing the settings or boot boundary.
 * @returns whether the value is a built-in brand greeting mode.
 */
export function isBrandGreetingMode(value: unknown): value is BrandGreetingMode {
  return BRAND_GREETING_MODES.some(mode => mode === value)
}
