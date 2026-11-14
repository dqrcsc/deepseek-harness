/** Built-in localized display names for the four brand identity presets. */
import type { BrandPreset } from '../theme-settings.ts'

/** Canonical wordmark strings per preset and display format. */
export const BRAND_PRESET_NAMES: Readonly<Record<BrandPreset, Readonly<Record<'bilingual' | 'zh' | 'en', string>>>> = {
  reins: { bilingual: '执辔 Reins', zh: '执辔', en: 'Reins' },
  loom: { bilingual: '灵枢 Loom', zh: '灵枢', en: 'Loom' },
  lumen: { bilingual: '澄明 Lumen', zh: '澄明', en: 'Lumen' },
  deepseek: { bilingual: 'DeepSeek', zh: 'DeepSeek', en: 'DeepSeek' },
}
