/**
 * Appearance preference row registered into the General section item slot
 * (figma 501:30012 'Frame 2117131228'): title + three preference cubes, plus
 * the visual theme gallery below. Registered by this package — the theme
 * feature owns its own settings surface. Selection follows the persisted
 * preference and style, never the resolved active theme.
 */
import clsx from 'clsx'
import {
  IconDarkOutlineMedium, IconFollowsystemOutlineMedium, IconLightOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemePreference, ThemeStyle } from '../theme-settings.ts'
import type { ThemeKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createAppearanceRowStore } from './settings-store.ts'
import css from './AppearanceRow.module.css'

/** Injected business face: the preference and style writes (t rides the standard locale seat). */
export interface AppearanceRowInjected {
  /** Switch the theme preference. */
  setTheme: (id: ThemePreference) => void
  /** Switch the visual theme style. */
  setStyle: (style: ThemeStyle) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type AppearanceRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createAppearanceRowStore>>
  & PropsLocale<'settings.theme'> & AppearanceRowInjected

/** Cube order and icons (figma 501:30015-30017: Light, Dark, System). */
const CUBES: readonly { id: ThemePreference; labelKey: ThemeKey; Icon: typeof IconLightOutlineMedium }[] = [
  { id: 'light', labelKey: 'appearance.light', Icon: IconLightOutlineMedium },
  { id: 'dark', labelKey: 'appearance.dark', Icon: IconDarkOutlineMedium },
  { id: 'system', labelKey: 'appearance.system', Icon: IconFollowsystemOutlineMedium },
]

/** Curated visual theme styles shown in the Appearance gallery. */
const STYLES: readonly { id: ThemeStyle; labelKey: ThemeKey; descriptionKey: ThemeKey }[] = [
  { id: 'antigravity', labelKey: 'appearance.style.antigravity', descriptionKey: 'appearance.style.antigravity.description' },
  { id: 'codex', labelKey: 'appearance.style.codex', descriptionKey: 'appearance.style.codex.description' },
  { id: 'warm', labelKey: 'appearance.style.warm', descriptionKey: 'appearance.style.warm.description' },
  { id: 'linear', labelKey: 'appearance.style.linear', descriptionKey: 'appearance.style.linear.description' },
  { id: 'craft', labelKey: 'appearance.style.craft', descriptionKey: 'appearance.style.craft.description' },
  { id: 'aurora', labelKey: 'appearance.style.aurora', descriptionKey: 'appearance.style.aurora.description' },
  { id: 'nord', labelKey: 'appearance.style.nord', descriptionKey: 'appearance.style.nord.description' },
  { id: 'classic', labelKey: 'appearance.style.classic', descriptionKey: 'appearance.style.classic.description' },
]

/**
 * Render the Appearance row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function AppearanceRow({ t, setTheme, setStyle, useStore }: AppearanceRowComponentProps) {
  const preference = useStore(s => s.preference)
  const style = useStore(s => s.style)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('appearance.title')}</div>
      <div className={css.cubeRow}>
        {CUBES.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            className={clsx(css.themeCube, preference === id && css.selected)}
            aria-pressed={preference === id}
            onClick={() => { setTheme(id) }}
          >
            <Icon />
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className={css.styleSection}>
        <div className={css.title}>{t('appearance.style.title')}</div>
        <div className={css.styleGrid}>
          {STYLES.map(({ id, labelKey, descriptionKey }) => (
            <button
              key={id}
              type="button"
              className={clsx(css.styleCard, style === id && css.selected)}
              aria-pressed={style === id}
              onClick={() => { setStyle(id) }}
            >
              <span className={css.styleSwatch} data-preview-style={id} aria-hidden="true">
                <span className={css.swatchSidebar}>
                  <span className={css.swatchDots}>
                    <span className={css.swatchDot} />
                    <span className={css.swatchDot} />
                    <span className={css.swatchDot} />
                  </span>
                  <span className={css.swatchNavActive} />
                  <span className={css.swatchNavIdle} />
                </span>
                <span className={css.swatchMain}>
                  <span className={css.swatchStage}>
                    <span className={css.swatchHeroTitle} />
                    <span className={css.swatchBubble} />
                  </span>
                  <span className={css.swatchComposer}>
                    <span className={css.swatchPrompt} />
                    <span className={css.swatchAccent} />
                  </span>
                </span>
              </span>
              <span className={css.styleCopy}>
                <span className={css.styleHeader}>
                  <span className={css.styleLabel}>{t(labelKey)}</span>
                  <span className={css.styleIndicator} aria-hidden="true" />
                </span>
                <span className={css.styleDescription}>{t(descriptionKey)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
