/** Sculptural vector brand marks for Reins (R4), Loom (A1), Lumen (B1), and DeepSeek. */
import { useId } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrandPreset } from '@deepseek-ai/dsh-client-ui-theme/client'
import css from './BrandArtwork.module.css'

/**
 * Normalize an optional build-time edition version, falling back to `'v1.0.0'`.
 * @param configured - Optional `DSH_CLIENT_EDITION_VERSION` build value.
 * @returns Non-empty edition version string prefixed with `v`, or `'v1.0.0'`.
 */
export function resolveEditionVersion(configured: string | undefined): string {
  const trimmed = configured?.trim()
  if (trimmed === undefined || trimmed === '') return 'v1.0.0'
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`
}

/** Version string of this customized edition shown in Settings attribution. */
export const CUSTOM_EDITION_VERSION: string = resolveEditionVersion(process.env.DSH_CLIENT_EDITION_VERSION)

/** Props accepted by {@link BrandSculptureMark}. */
export interface BrandSculptureMarkProps {
  /** Which built-in brand preset emblem to draw. */
  readonly preset: BrandPreset
  /** Square viewport size in CSS pixels. */
  readonly size: number
  /** Whether the surrounding Hero or card is pointer-hovered. */
  readonly hovering?: boolean | undefined
}

const LOOM_BLADE_PATH = 'M17.2 4.4C24.2 4.4 30.0 9.6 30.6 16.4C30.8 18.3 29.0 19.6 27.2 18.9C24.4 17.9 22.4 15.8 21.1 13.1C20.0 10.9 18.1 9.6 15.7 9.4C14.2 9.2 13.6 7.7 14.5 6.4C15.3 5.1 16.2 4.4 17.2 4.4Z'

/** Sanitize `useId()` output so every inlined SVG `<defs>` id stays collision-free across the document. */
function useSvgPrefix(tag: string): string {
  const raw = useId()
  return `dsh-brand-${tag}-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
}

/** R4: Interlocked horsebit rings with central clasp bar and flowing silk reins (执辔 Reins). */
function ReinsHorsebitMark({ size }: { readonly size: number }) {
  const prefix = useSvgPrefix('reins')
  const gradPrimary = `${prefix}-hb1`
  const gradRibbon = `${prefix}-hb2`
  const bitCutMask = `${prefix}-cut`
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" className={css.svg} data-brand-preset="reins" aria-hidden="true">
      <defs>
        <linearGradient id={gradPrimary} x1="5" y1="28" x2="30" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--dsw-specific-brand-stop-spark, currentColor)" />
          <stop offset="0.5" stopColor="var(--dsw-specific-brand-stop-mid, currentColor)" />
          <stop offset="1" stopColor="var(--dsw-specific-brand-stop-deep, currentColor)" />
        </linearGradient>
        <linearGradient id={gradRibbon} x1="8" y1="8" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--dsw-specific-brand-stop-light, currentColor)" />
          <stop offset="1" stopColor="var(--dsw-specific-brand-stop-mid, currentColor)" />
        </linearGradient>
        <mask id={bitCutMask}>
          <rect width="36" height="36" fill="#ffffff" />
          <path d="M13.6 22.4L22.4 13.6" stroke="#000000" strokeWidth="5.2" strokeLinecap="round" />
        </mask>
      </defs>
      <g mask={`url(#${bitCutMask})`}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M10.8 16.8A5.6 5.6 0 1 1 10.8 28.0A5.6 5.6 0 1 1 10.8 16.8ZM10.8 19.6A2.8 2.8 0 1 0 10.8 25.2A2.8 2.8 0 1 0 10.8 19.6Z"
          fill={`url(#${gradPrimary})`}
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M25.2 5.6A5.6 5.6 0 1 1 25.2 16.8A5.6 5.6 0 1 1 25.2 5.6ZM25.2 8.4A2.8 2.8 0 1 0 25.2 14.0A2.8 2.8 0 1 0 25.2 8.4Z"
          fill={`url(#${gradPrimary})`}
        />
      </g>
      <path d="M12.6 23.4L23.4 12.6" stroke={`url(#${gradRibbon})`} strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="18" cy="18" r="2.7" fill={`url(#${gradPrimary})`} />
      <path
        d="M10.8 28.0C14.8 30.8 20.2 31.4 26.2 29.6C20.8 29.2 16.4 27.6 13.4 25.2Z"
        fill={`url(#${gradRibbon})`}
        fillOpacity="0.82"
      />
      <path
        d="M29.8 14.2C31.4 19.6 30.6 24.6 27.8 28.4C28.4 23.6 27.6 19.4 25.6 16.2Z"
        fill={`url(#${gradPrimary})`}
        fillOpacity="0.72"
      />
    </svg>
  )
}

/** A1: Four-fold Möbius spindle knot with true over-under masked weave (灵枢 Loom). */
function LoomSpindleMark({ size }: { readonly size: number }) {
  const prefix = useSvgPrefix('loom')
  const gradMain = `${prefix}-g1`
  const gradAlt = `${prefix}-g2`
  const mask0 = `${prefix}-k0`
  const mask1 = `${prefix}-k1`
  const mask2 = `${prefix}-k2`
  const mask3 = `${prefix}-k3`
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" className={css.svg} data-brand-preset="loom" aria-hidden="true">
      <defs>
        <linearGradient id={gradMain} x1="6" y1="5" x2="30" y2="31" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--dsw-specific-brand-stop-light, currentColor)" />
          <stop offset="0.52" stopColor="var(--dsw-specific-brand-stop-mid, currentColor)" />
          <stop offset="1" stopColor="var(--dsw-specific-brand-stop-deep, currentColor)" />
        </linearGradient>
        <linearGradient id={gradAlt} x1="30" y1="6" x2="7" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--dsw-specific-brand-stop-spark, currentColor)" />
          <stop offset="1" stopColor="var(--dsw-specific-brand-stop-mid, currentColor)" />
        </linearGradient>
        <mask id={mask0}>
          <rect width="36" height="36" fill="#ffffff" />
          <path d={LOOM_BLADE_PATH} transform="rotate(90 18 18)" stroke="#000000" strokeWidth="2.1" strokeLinejoin="round" />
        </mask>
        <mask id={mask1}>
          <rect width="36" height="36" fill="#ffffff" />
          <path d={LOOM_BLADE_PATH} transform="rotate(180 18 18)" stroke="#000000" strokeWidth="2.1" strokeLinejoin="round" />
        </mask>
        <mask id={mask2}>
          <rect width="36" height="36" fill="#ffffff" />
          <path d={LOOM_BLADE_PATH} transform="rotate(270 18 18)" stroke="#000000" strokeWidth="2.1" strokeLinejoin="round" />
        </mask>
        <mask id={mask3}>
          <rect width="36" height="36" fill="#ffffff" />
          <path d={LOOM_BLADE_PATH} stroke="#000000" strokeWidth="2.1" strokeLinejoin="round" />
        </mask>
      </defs>
      <path d={LOOM_BLADE_PATH} fill={`url(#${gradMain})`} mask={`url(#${mask0})`} />
      <path d={LOOM_BLADE_PATH} transform="rotate(90 18 18)" fill={`url(#${gradAlt})`} fillOpacity="0.92" mask={`url(#${mask1})`} />
      <path d={LOOM_BLADE_PATH} transform="rotate(180 18 18)" fill={`url(#${gradMain})`} mask={`url(#${mask2})`} />
      <path d={LOOM_BLADE_PATH} transform="rotate(270 18 18)" fill={`url(#${gradAlt})`} fillOpacity="0.92" mask={`url(#${mask3})`} />
      <path
        d="M18 13.2C18.6 16.7 19.3 17.4 22.8 18C19.3 18.6 18.6 19.3 18 22.8C17.4 19.3 16.7 18.6 13.2 18C16.7 17.4 17.4 16.7 18 13.2Z"
        fill={`url(#${gradMain})`}
      />
    </svg>
  )
}

/** B1: Nested corona eclipse crescents with diamond star flare (澄明 Lumen). */
function LumenCoronaMark({ size }: { readonly size: number }) {
  const prefix = useSvgPrefix('lumen')
  const gradRing = `${prefix}-lg1`
  const gradStar = `${prefix}-lg2`
  const maskOuter = `${prefix}-cres1`
  const maskInner = `${prefix}-cres2`
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" className={css.svg} data-brand-preset="lumen" aria-hidden="true">
      <defs>
        <linearGradient id={gradRing} x1="5" y1="29" x2="29" y2="7" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--dsw-specific-brand-stop-deep, currentColor)" />
          <stop offset="0.55" stopColor="var(--dsw-specific-brand-stop-mid, currentColor)" />
          <stop offset="1" stopColor="var(--dsw-specific-brand-stop-light, currentColor)" />
        </linearGradient>
        <linearGradient id={gradStar} x1="17" y1="6" x2="31" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--dsw-specific-brand-stop-spark, currentColor)" />
          <stop offset="1" stopColor="var(--dsw-specific-brand-stop-mid, currentColor)" />
        </linearGradient>
        <mask id={maskOuter}>
          <rect width="36" height="36" fill="#000000" />
          <circle cx="17.2" cy="18.8" r="12.6" fill="#ffffff" />
          <circle cx="21.2" cy="14.8" r="9.6" fill="#000000" />
        </mask>
        <mask id={maskInner}>
          <rect width="36" height="36" fill="#000000" />
          <circle cx="18.4" cy="19.6" r="10.4" fill="#ffffff" />
          <circle cx="21.6" cy="15.2" r="8.2" fill="#000000" />
        </mask>
      </defs>
      <rect width="36" height="36" fill={`url(#${gradRing})`} mask={`url(#${maskOuter})`} />
      <rect width="36" height="36" fill={`url(#${gradStar})`} fillOpacity="0.58" mask={`url(#${maskInner})`} />
      <path
        d="M23.4 4.8C23.9 10.5 25.0 11.6 30.7 12.1C25.0 12.6 23.9 13.7 23.4 19.4C22.9 13.7 21.8 12.6 16.1 12.1C21.8 11.6 22.9 10.5 23.4 4.8Z"
        fill={`url(#${gradRing})`}
      />
      <circle cx="15.6" cy="20.4" r="1.75" fill={`url(#${gradStar})`} fillOpacity="0.85" />
    </svg>
  )
}

/**
 * Render the active brand mark sculpture at the requested pixel size.
 * @param props - Brand preset, size, and optional hover motion flag.
 * @returns The brand mark SVG element.
 */
export function BrandSculptureMark({ preset, size, hovering = false }: BrandSculptureMarkProps) {
  const className = hovering ? `${css.mark} ${css.hovering}` : css.mark
  if (preset === 'deepseek') {
    return (
      <span className={className} data-brand-mark="deepseek">
        <FishLogo size={size} className={css.svg} />
      </span>
    )
  }
  if (preset === 'loom') {
    return (
      <span className={className} data-brand-mark="loom">
        <LoomSpindleMark size={size} />
      </span>
    )
  }
  if (preset === 'lumen') {
    return (
      <span className={className} data-brand-mark="lumen">
        <LumenCoronaMark size={size} />
      </span>
    )
  }
  return (
    <span className={className} data-brand-mark="reins">
      <ReinsHorsebitMark size={size} />
    </span>
  )
}
