/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference, font sizes, and
 * font-family lists. Head CSS colors the document canvas before script
 * execution; the body script installs the palette selector and font variables
 * that the client presenters adopt.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_BRAND_SNAPSHOT, DEFAULT_FONT_SIZES, DEFAULT_PREFERENCE, DEFAULT_THEME_STYLE, FONT_ROLES, FONT_SIZE_SPECS,
  fontFamilyVariable, normalizeFontFamily,
  type BrandSnapshot, type FontFamilies, type FontSizes, type ThemePreference, type ThemeStyle,
} from './theme-settings.ts'

const BOOT_BACKGROUNDS: Readonly<Record<ThemeStyle, { readonly light: string; readonly dark: string }>> = {
  antigravity: { light: '#f6f8fe', dark: '#0d1017' },
  codex: { light: '#f7f7f8', dark: '#0f0f10' },
  warm: { light: '#f6f3eb', dark: '#191714' },
  linear: { light: '#f4f5f8', dark: '#0b0c0e' },
  craft: { light: '#f5f8fc', dark: '#11141b' },
  aurora: { light: '#f7f6fe', dark: '#11111c' },
  nord: { light: '#eceff4', dark: '#2e3440' },
  classic: { light: '#fff', dark: '#151517' },
}

/** CSS that colors the document canvas before any script executes. */
function bootThemeStyle(preference: ThemePreference, style: ThemeStyle): string {
  const palette = BOOT_BACKGROUNDS[style]
  const light = `:root{color-scheme:light}body{background-color:${palette.light};--dsh-boot-bg:${palette.light}}`
  const dark = `:root{color-scheme:dark}body{background-color:${palette.dark};--dsh-boot-bg:${palette.dark}}`
  if (preference === 'light') return light
  if (preference === 'dark') return dark
  return `${light}@media(prefers-color-scheme:dark){${dark}}`
}

/** Build the body script that installs the palette selector, visual style, brand identity, and font variables. */
function bootThemeBodyScript(
  preference: ThemePreference,
  fontSizes: FontSizes,
  fontFamilies: FontFamilies,
  style: ThemeStyle,
  brand: BrandSnapshot,
): string {
  const sizes = FONT_ROLES.map(role =>
    `\n  document.body.style.setProperty(${JSON.stringify(FONT_SIZE_SPECS[role].variable)}, ${JSON.stringify(`${fontSizes[role]}px`)})`).join('')
  const families = FONT_ROLES.flatMap((kind) => {
    const list = normalizeFontFamily(fontFamilies[kind])
    return list === '' ? [] : [`\n  document.body.style.setProperty(${JSON.stringify(fontFamilyVariable(kind))}, ${JSON.stringify(list)})`]
  }).join('')
  const brandCustom = [
    brand.customName === '' ? '' : `\n  document.body.dataset.dsBrandCustomName = ${JSON.stringify(brand.customName)}`,
    brand.customGreeting === '' ? '' : `\n  document.body.dataset.dsBrandCustomGreeting = ${JSON.stringify(brand.customGreeting)}`,
  ].join('')
  return `(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.dataset.dsThemeStyle = ${JSON.stringify(style)}
  document.body.dataset.dsBrandPreset = ${JSON.stringify(brand.preset)}
  document.body.dataset.dsBrandLabelMode = ${JSON.stringify(brand.labelMode)}
  document.body.dataset.dsBrandGreetingMode = ${JSON.stringify(brand.greetingMode)}${brandCustom}${sizes}${families}
})()`
}

/**
 * Theme bootstrap rows: head CSS colors the document canvas before
 * first paint, then the body script installs the palette selector, visual
 * style, brand identity, font size, and font families before the shell mount and module script.
 * @param preference - Current Host-backed built-in preference.
 * @param fontSizes - Current Host-backed font sizes in px by role.
 * @param fontFamilies - Current Host-backed font lists; each is normalized before embedding.
 * @param style - Current Host-backed visual theme style.
 * @param brand - Current Host-backed brand identity snapshot.
 * @returns head and body script rows in execution order.
 */
export function bootThemeInjections(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSizes: FontSizes = DEFAULT_FONT_SIZES,
  fontFamilies: FontFamilies = { text: '', code: '', terminal: '' },
  style: ThemeStyle = DEFAULT_THEME_STYLE,
  brand: BrandSnapshot = DEFAULT_BRAND_SNAPSHOT,
): IndexInjection[] {
  return [
    { kind: 'style', text: bootThemeStyle(preference, style) },
    { kind: 'script', placement: 'body', text: bootThemeBodyScript(preference, fontSizes, fontFamilies, style, brand) },
  ]
}
