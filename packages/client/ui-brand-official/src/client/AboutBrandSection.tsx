/** Settings section for custom edition attribution, upstream DSH version metadata, and live brand customization. */
import { useEffect, useId, useRef, useState } from 'react'
import {
  FishLogo, IconCheckOutlineRegular, IconCopyOutlineRegular, Input, SegmentedControl, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  BrandGreetingMode, BrandLabelMode, BrandPreset, ThemeSnapshot,
} from '@deepseek-ai/dsh-client-ui-theme/client'
import { BrandSculptureMark, CUSTOM_EDITION_VERSION } from './BrandArtwork.tsx'
import { resolveBrandMottoKey, resolveHeroHeadlineText } from './Brand.tsx'
import type { BrandLocaleKey } from './locales.ts'
import css from './AboutBrandSection.module.css'

/** Host/runtime operations injected into {@link AboutBrandSection}. */
export interface AboutBrandSectionInjected {
  /** Reactive theme snapshot carrying the active brand settings. */
  hooks: {
    theme: HostObservable<ThemeSnapshot>
  }
  /** Switch the active brand emblem preset. */
  setBrandPreset: (preset: BrandPreset) => void
  /** Switch the sidebar wordmark display format. */
  setBrandLabelMode: (mode: BrandLabelMode) => void
  /** Update the custom sidebar wordmark string. */
  setCustomBrandName: (name: string) => void
  /** Switch the Hero welcome headline mode. */
  setBrandGreetingMode: (mode: BrandGreetingMode) => void
  /** Update the custom Hero welcome headline string. */
  setCustomBrandGreeting: (greeting: string) => void
}

/** Composed props for {@link AboutBrandSection}. */
export type AboutBrandSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.brand'>
  & InjectFace<AboutBrandSectionInjected>

const PRESET_CARDS: readonly {
  readonly id: BrandPreset
  readonly nameKey: BrandLocaleKey
  readonly mottoKey: BrandLocaleKey
  readonly craftKey: BrandLocaleKey
  readonly defaultBadge?: boolean
}[] = [
  {
    id: 'reins',
    nameKey: 'preset.reins.name',
    mottoKey: 'preset.reins.motto',
    craftKey: 'preset.reins.craft',
    defaultBadge: true,
  },
  {
    id: 'loom',
    nameKey: 'preset.loom.name',
    mottoKey: 'preset.loom.motto',
    craftKey: 'preset.loom.craft',
  },
  {
    id: 'lumen',
    nameKey: 'preset.lumen.name',
    mottoKey: 'preset.lumen.motto',
    craftKey: 'preset.lumen.craft',
  },
  {
    id: 'deepseek',
    nameKey: 'preset.deepseek.name',
    mottoKey: 'preset.deepseek.motto',
    craftKey: 'preset.deepseek.craft',
  },
]

const COPY_FEEDBACK_MS = 1_800

/** Read the internal DSH commit revision from build env when available. */
function formatCommitRevision(fallback: string) {
  const commit = process.env.DSH_CLIENT_COMMIT_HASH
  if (commit === undefined || commit === '') return fallback
  return process.env.DSH_CLIENT_GIT_DIRTY === 'true' ? `${commit}-dirty` : commit
}

/**
 * Render the About & Brand settings section.
 * @param props - Reactive theme hook, localized dictionary, and brand mutation callbacks.
 * @returns The section element tree.
 */
export function AboutBrandSection({
  t,
  useTheme,
  setBrandPreset,
  setBrandLabelMode,
  setCustomBrandName,
  setBrandGreetingMode,
  setCustomBrandGreeting,
}: AboutBrandSectionProps) {
  const brand = useTheme(snapshot => snapshot.brand)
  const style = useTheme(snapshot => snapshot.style)
  const labelControlId = useId()
  const greetingControlId = useId()
  const [hoveredCard, setHoveredCard] = useState<BrandPreset | 'edition' | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const lastAnnouncement = useRef('')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])

  const coreVersion = process.env.DSH_CLIENT_VERSION ?? t('localDevFallback')
  const commitRevision = formatCommitRevision(t('localDevFallback'))
  const diagnosticsPayload = [
    `${brand.title} ${CUSTOM_EDITION_VERSION}`,
    `DSH Core: ${coreVersion}`,
    `Commit: ${commitRevision}`,
    `Style: ${style} | Preset: ${brand.preset}`,
  ].join('\n')

  const handleCopyDiagnostics = (): void => {
    if (copyTimer.current !== null) {
      clearTimeout(copyTimer.current)
      copyTimer.current = null
    }
    void writeClipboard(diagnosticsPayload).then((ok) => {
      let message = ok ? t('copied') : t('copyFailed')
      if (message === lastAnnouncement.current) message += '\u00A0'
      lastAnnouncement.current = message
      setCopyState(ok ? 'copied' : 'failed')
      setStatusMessage(message)
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null
        setCopyState('idle')
        setStatusMessage('')
      }, COPY_FEEDBACK_MS)
    })
  }

  const resolvedHeadline = resolveHeroHeadlineText({
    preset: brand.preset,
    greetingMode: brand.greetingMode,
    customGreeting: brand.customGreeting,
    t,
  })

  return (
    <div className={css.section} role="region" aria-label={t('nav')}>
      <div
        className={css.attributionCard}
        onPointerEnter={() => { setHoveredCard('edition') }}
        onPointerLeave={() => { setHoveredCard(current => current === 'edition' ? null : current) }}
      >
        <div className={css.editionRow}>
          <span className={css.editionEmblem}>
            <BrandSculptureMark preset={brand.preset} size={30} hovering={hoveredCard === 'edition'} />
          </span>
          <div className={css.editionCopy}>
            <div className={css.editionTitleRow}>
              <span className={css.editionTitle}>{brand.title}</span>
              <span className={css.versionPill}>{CUSTOM_EDITION_VERSION}</span>
              <span className={css.editionKind}>{t('editionBadge')}</span>
            </div>
            <div className={css.editionMotto}>{t(resolveBrandMottoKey(brand.preset))}</div>
          </div>
        </div>
        <div className={css.divider} />
        <div className={css.engineRow}>
          <div className={css.engineIdentity}>
            <span className={css.whaleBadge} aria-hidden="true">
              <FishLogo size={20} />
            </span>
            <div className={css.engineText}>
              <span className={css.engineTitle}>{t('engineTitle')}</span>
              <span className={css.engineSubtitle}>{t('engineSubtitle')}</span>
            </div>
          </div>
          <span className={css.copyCluster}>
            <button
              type="button"
              className={css.copyButton}
              data-copied={copyState === 'copied' ? '' : undefined}
              data-failed={copyState === 'failed' ? '' : undefined}
              onClick={handleCopyDiagnostics}
            >
              <span className={css.copyIcon} aria-hidden="true">
                {copyState === 'copied' ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
              </span>
              <span>{t('copyDiagnostics')}</span>
            </button>
            <span
              className={css.copyStatus}
              role="status"
              data-visible={statusMessage !== '' ? '' : undefined}
            >
              {statusMessage}
            </span>
          </span>
        </div>
        <div className={css.metaGrid}>
          <div className={css.metaCell}>
            <span className={css.metaLabel}>{t('editionVersionLabel')}</span>
            <span className={css.metaValue}>{CUSTOM_EDITION_VERSION}</span>
          </div>
          <div className={css.metaCell}>
            <span className={css.metaLabel}>{t('engineVersionLabel')}</span>
            <span className={css.metaValue}>{coreVersion}</span>
          </div>
          <div className={css.metaCell}>
            <span className={css.metaLabel}>{t('commitLabel')}</span>
            <span className={css.metaValue}>{commitRevision}</span>
          </div>
        </div>
      </div>

      <div className={css.group}>
        <div className={css.groupHeader}>
          <div className={css.groupTitle}>{t('presetSectionTitle')}</div>
          <div className={css.groupDescription}>{t('presetSectionDescription')}</div>
        </div>
        <div className={css.presetGrid}>
          {PRESET_CARDS.map(item => (
            <button
              key={item.id}
              type="button"
              className={css.presetCard}
              aria-pressed={brand.preset === item.id}
              onPointerEnter={() => { setHoveredCard(item.id) }}
              onPointerLeave={() => { setHoveredCard(current => current === item.id ? null : current) }}
              onClick={() => { setBrandPreset(item.id) }}
            >
              <span className={css.presetIconBox} aria-hidden="true">
                <BrandSculptureMark preset={item.id} size={28} hovering={hoveredCard === item.id} />
              </span>
              <span className={css.presetBody}>
                <span className={css.presetTop}>
                  <span className={css.presetTitleWrap}>
                    <span className={css.presetTitle}>{t(item.nameKey)}</span>
                    {item.defaultBadge === true && (
                      <span className={css.defaultPill}>{t('preset.reins.badge')}</span>
                    )}
                  </span>
                  <span className={css.radioDot} aria-hidden="true" />
                </span>
                <span className={css.presetMotto}>{t(item.mottoKey)}</span>
                <span className={css.presetCraft}>{t(item.craftKey)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className={css.controlRow}>
        <div className={css.groupTitle}>{t('labelModeTitle')}</div>
        <SegmentedControl
          id={labelControlId}
          label={t('labelModeTitle')}
          value={brand.labelMode}
          onChange={setBrandLabelMode}
          options={[
            { value: 'bilingual', label: t('labelMode.bilingual') },
            { value: 'zh', label: t('labelMode.zh') },
            { value: 'en', label: t('labelMode.en') },
            { value: 'custom', label: t('labelMode.custom') },
          ]}
        />
        <div
          id={`${labelControlId}-${brand.labelMode}-panel`}
          role="tabpanel"
          aria-labelledby={`${labelControlId}-${brand.labelMode}`}
          className={css.modePanel}
        >
          {brand.labelMode === 'custom' && (
            <Input
              value={brand.customName}
              maxLength={40}
              placeholder={t('customNamePlaceholder')}
              aria-label={t('customNameAria')}
              onChange={(event) => { setCustomBrandName(event.currentTarget.value) }}
            />
          )}
          <div className={css.previewChip}>
            <BrandSculptureMark preset={brand.preset} size={18} />
            <span className={css.previewText}>{brand.title}</span>
          </div>
        </div>
      </div>

      <div className={css.controlRow}>
        <div className={css.groupTitle}>{t('greetingModeTitle')}</div>
        <SegmentedControl
          id={greetingControlId}
          label={t('greetingModeTitle')}
          value={brand.greetingMode}
          onChange={setBrandGreetingMode}
          options={[
            { value: 'brand', label: t('greetingMode.brand') },
            { value: 'time', label: t('greetingMode.time') },
            { value: 'custom', label: t('greetingMode.custom') },
          ]}
        />
        <div
          id={`${greetingControlId}-${brand.greetingMode}-panel`}
          role="tabpanel"
          aria-labelledby={`${greetingControlId}-${brand.greetingMode}`}
          className={css.modePanel}
        >
          {brand.greetingMode === 'custom' && (
            <Input
              value={brand.customGreeting}
              maxLength={80}
              placeholder={t('customGreetingPlaceholder')}
              aria-label={t('customGreetingAria')}
              onChange={(event) => { setCustomBrandGreeting(event.currentTarget.value) }}
            />
          )}
          <div className={css.previewChip}>
            <BrandSculptureMark preset={brand.preset} size={20} />
            <span className={css.previewText}>{resolvedHeadline}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
