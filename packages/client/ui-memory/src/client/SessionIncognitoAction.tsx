/** Composer incognito mode chip isolating memory writes and cross-session recall. */
import { useEffect, useState } from 'react'
import {
  IconCloseCircleFillRegular,
  IconEyeOffOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemoryActionOutcome, MemoryCatalogSnapshot } from './catalog-source.ts'
import type { NS } from './locales.ts'
import css from './SessionIncognitoAction.module.css'

/** Injected state and toggle handler for the composer incognito mode chip. */
export interface SessionIncognitoInjected {
  readonly hooks: { readonly catalog: HostObservable<MemoryCatalogSnapshot> }
  readonly ensureSessionPolicy: (sessionId: SessionId) => Promise<void>
  readonly setSessionIncognito: (sessionId: SessionId, incognito: boolean) => Promise<MemoryActionOutcome>
}

/** Full props of the composer incognito mode chip. */
export type SessionIncognitoActionProps =
  PropsRuntime<'conversation.input.left'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionIncognitoInjected>

/**
 * Render the active Session incognito mode chip while the Peer may update Session policy.
 * @param props - composer slot runtime hooks, localized dictionary, and policy controller.
 * @returns active incognito mode chip button, or null when unauthorized, closed, or non-incognito.
 */
export function SessionIncognitoAction(props: SessionIncognitoActionProps) {
  return props.useAccess('memory/setSessionPolicy') ? <SessionIncognitoButton {...props} /> : null
}

function SessionIncognitoButton({
  sessionId,
  useSession,
  useCatalog,
  ensureSessionPolicy,
  setSessionIncognito,
  t,
}: SessionIncognitoActionProps) {
  const openState = useSession(snapshot => snapshot.openState)
  const incognito = useCatalog(snapshot => snapshot.sessionIncognito[sessionId] === true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (openState !== 'open') return
    void ensureSessionPolicy(sessionId)
  }, [ensureSessionPolicy, openState, sessionId])

  if (openState !== 'open' || !incognito) return null

  return (
    <span className={css.wrap}>
      <Tooltip label={t('incognito.tooltipOn')} side="top" portal maxWidth={280}>
        <button
          type="button"
          className={css.chip}
          data-memory-incognito-toggle=""
          aria-pressed="true"
          aria-label={t('incognito.disableLabel')}
          disabled={saving}
          onClick={() => {
            setSaving(true)
            void setSessionIncognito(sessionId, false).finally(() => {
              setSaving(false)
            })
          }}
        >
          <span className={css.glyph} aria-hidden>
            <IconEyeOffOutlineRegular className={css.restGlyph} size={14} />
            <IconCloseCircleFillRegular className={css.hoverGlyph} size={14} />
          </span>
          <span className={css.badgeText}>{t('incognito.badge')}</span>
        </button>
      </Tooltip>
    </span>
  )
}
