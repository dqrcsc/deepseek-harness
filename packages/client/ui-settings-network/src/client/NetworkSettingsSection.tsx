/**
 * Settings -> Network & Proxy configuration page (`id: 'network'`).
 * @module @deepseek-ai/dsh-client-ui-settings-network/client/NetworkSettingsSection
 */

import clsx from 'clsx'
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  Button,
  IconEditOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  SegmentedControl,
  StateDot,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AddSubscriptionRequest,
  CapabilityRoutingOverrides,
  NetworkProxyMode,
  RouteOverridePolicy,
  RoutingCapabilityKey,
  SubscriptionSummary,
  UpdateNetworkRoutingRequest,
  UpdateSubscriptionRequest,
  VpnNodeId,
  VpnSubscriptionId,
} from '@deepseek-ai/dsh-network-proxy/client'
import type { NetworkSettingsLocaleKey, NS } from './locales.ts'
import { findSelectedNode, formatByteQuota, type NetworkProxyViewSnapshot } from './network-source.ts'
import css from './NetworkSettingsSection.module.css'

const PROVIDER_ROWS: readonly { readonly id: string; readonly labelKey: NetworkSettingsLocaleKey }[] = [
  { id: 'deepseek-official', labelKey: 'routing.provider.deepseek' },
  { id: 'openai', labelKey: 'routing.provider.openai' },
  { id: 'anthropic', labelKey: 'routing.provider.anthropic' },
  { id: 'google', labelKey: 'routing.provider.google' },
  { id: 'openrouter', labelKey: 'routing.provider.openrouter' },
  { id: 'xai', labelKey: 'routing.provider.xai' },
]

const CAPABILITY_ROWS: readonly { readonly key: RoutingCapabilityKey; readonly labelKey: NetworkSettingsLocaleKey }[] = [
  { key: 'web', labelKey: 'routing.cap.web' },
  { key: 'mcp', labelKey: 'routing.cap.mcp' },
  { key: 'plugin', labelKey: 'routing.cap.plugin' },
  { key: 'embedding', labelKey: 'routing.cap.embedding' },
]

/** Raw slot `inject()` payload for {@link NetworkSettingsSection}. */
export interface NetworkSettingsInjected {
  /** Observable network proxy view source bound by the slot renderer as `useNetwork`. */
  readonly hooks: {
    /** Network proxy view source. */
    readonly network: HostObservable<NetworkProxyViewSnapshot>
  }
  /** Dismiss the active inline error banner. */
  readonly onClearError: () => void
  /** Switch outbound proxy mode (`direct`, `smart`, or `global`). */
  readonly onSetMode: (mode: NetworkProxyMode) => Promise<boolean>
  /** Import unimported `SUB_VPN_*` / `VPN_SUB_*` entries from `.env`. */
  readonly onImportEnv: () => Promise<boolean>
  /** Add a VPN subscription and store its secret URL in credentials. */
  readonly onAddSubscription: (request: AddSubscriptionRequest) => Promise<boolean>
  /** Update an existing subscription's metadata or secret URL. */
  readonly onUpdateSubscription: (request: UpdateSubscriptionRequest) => Promise<boolean>
  /** Remove a subscription and delete its encrypted node cache. */
  readonly onRemoveSubscription: (id: VpnSubscriptionId) => Promise<boolean>
  /** Refresh all enabled subscriptions or one specific subscription. */
  readonly onRefreshSubscriptions: (id?: VpnSubscriptionId) => Promise<boolean>
  /** Update smart routing preferences, overrides, or custom Clash rules. */
  readonly onUpdateRouting: (request: UpdateNetworkRoutingRequest) => Promise<boolean>
  /** Pin a specific VPN node or pass `null` to restore automatic selection. */
  readonly onSelectNode: (nodeId: VpnNodeId | null) => Promise<boolean>
  /** Probe active VPN nodes for TCP/TLS latency. */
  readonly onProbeNodes: () => Promise<boolean>
  /** Run end-to-end domestic and overseas connectivity diagnostics. */
  readonly onRunDiagnostics: () => Promise<boolean>
}

/** Runtime props delivered to {@link NetworkSettingsSection}. */
export type NetworkSettingsProps =
  PropsRuntime<'settings.section'> &
  PropsLocale<typeof NS> &
  InjectFace<NetworkSettingsInjected>

interface BaseSubscriptionDraft {
  readonly name: string
  readonly url: string
  readonly autoRefreshMinutes: string
  readonly enabled: boolean
}

type SubscriptionDraft =
  | (BaseSubscriptionDraft & { readonly mode: 'add' })
  | (BaseSubscriptionDraft & {
    readonly mode: 'edit'
    readonly targetId: VpnSubscriptionId
    readonly targetName: string
  })

interface SettingsCardProps {
  readonly title: string
  readonly description?: string
  readonly actions?: ReactNode
  readonly children: ReactNode
}

function SettingsCard({ title, description, actions, children }: SettingsCardProps) {
  return (
    <section className={css.card}>
      <div className={css.cardHead}>
        <div className={css.cardHeadText}>
          <h3 className={css.cardTitle}>{title}</h3>
          {description !== undefined && <p className={css.cardDesc}>{description}</p>}
        </div>
        {actions !== undefined && <div className={css.cardActions}>{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * Render the full Settings -> Network & Proxy configuration page.
 * @param props - Settings section owner props, localized copy binder, and network controller hooks.
 * @returns Network & Proxy settings page element.
 */
export function NetworkSettingsSection({
  t,
  useNetwork,
  onClearError,
  onSetMode,
  onImportEnv,
  onAddSubscription,
  onUpdateSubscription,
  onRemoveSubscription,
  onRefreshSubscriptions,
  onUpdateRouting,
  onSelectNode,
  onProbeNodes,
  onRunDiagnostics,
}: NetworkSettingsProps) {
  const view = useNetwork(s => s)
  const { status } = view
  const baseId = useId()
  const modeControlId = `${baseId}-mode`

  const [draft, setDraft] = useState<SubscriptionDraft | null>(null)
  const [preferRegion, setPreferRegion] = useState(status.routing.preferRegion)
  const [maxLatencyText, setMaxLatencyText] = useState(String(status.routing.maxPreferredLatencyMs))
  const [customRulesText, setCustomRulesText] = useState(status.routing.customRules.join('\n'))

  useEffect(() => {
    setPreferRegion(status.routing.preferRegion)
    setMaxLatencyText(String(status.routing.maxPreferredLatencyMs))
    setCustomRulesText(status.routing.customRules.join('\n'))
  }, [
    status.routing.preferRegion,
    status.routing.maxPreferredLatencyMs,
    status.routing.customRules,
  ])

  const selectedNode = findSelectedNode(status)
  const unimportedEnvCandidates = status.ambientEnvCandidates.filter(item => !item.alreadyImported)

  const modeOptions = [
    { value: 'direct' as const, label: t('mode.direct') },
    { value: 'smart' as const, label: t('mode.smart') },
    { value: 'global' as const, label: t('mode.global') },
  ]

  const overrideOptions = [
    { value: 'auto' as const, label: t('routing.override.auto') },
    { value: 'direct' as const, label: t('routing.override.direct') },
    { value: 'proxy' as const, label: t('routing.override.proxy') },
  ]

  const modeDescription = status.mode === 'direct'
    ? t('mode.desc.direct')
    : status.mode === 'smart'
      ? t('mode.desc.smart')
      : t('mode.desc.global')

  const openAddDraft = (): void => {
    setDraft({
      mode: 'add',
      name: '',
      url: '',
      autoRefreshMinutes: '360',
      enabled: true,
    })
  }

  const openEditDraft = (sub: SubscriptionSummary): void => {
    setDraft({
      mode: 'edit',
      targetId: sub.id,
      targetName: sub.name,
      name: sub.name,
      url: '',
      autoRefreshMinutes: String(sub.autoRefreshMinutes),
      enabled: sub.enabled,
    })
  }

  const submitSubscriptionDraft = async (activeDraft: SubscriptionDraft): Promise<void> => {
    const trimmedMinutes = activeDraft.autoRefreshMinutes.trim()
    const parsedMinutes = trimmedMinutes.length > 0 ? Number(trimmedMinutes) : Number.NaN
    const autoRefreshMinutes = Number.isFinite(parsedMinutes) ? parsedMinutes : -1
    if (activeDraft.mode === 'add') {
      const ok = await onAddSubscription({
        name: activeDraft.name,
        url: activeDraft.url,
        enabled: activeDraft.enabled,
        autoRefreshMinutes,
      })
      if (ok) setDraft(null)
      return
    }
    const trimmedUrl = activeDraft.url.trim()
    const request: UpdateSubscriptionRequest = trimmedUrl.length > 0
      ? { id: activeDraft.targetId, name: activeDraft.name, url: trimmedUrl, enabled: activeDraft.enabled, autoRefreshMinutes }
      : { id: activeDraft.targetId, name: activeDraft.name, enabled: activeDraft.enabled, autoRefreshMinutes }
    const ok = await onUpdateSubscription(request)
    if (ok) setDraft(null)
  }

  const saveRoutingForm = async (): Promise<void> => {
    const trimmedCeiling = maxLatencyText.trim()
    const parsedCeiling = trimmedCeiling.length > 0 ? Number(trimmedCeiling) : Number.NaN
    const maxPreferredLatencyMs = Number.isFinite(parsedCeiling) ? parsedCeiling : -1
    const customRules = customRulesText
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line.length > 0)
    await onUpdateRouting({
      preferRegion,
      maxPreferredLatencyMs,
      customRules,
    })
  }

  const handleProviderOverride = (providerId: string, next: RouteOverridePolicy): void => {
    void onUpdateRouting({
      providerOverrides: {
        ...status.routing.providerOverrides,
        [providerId]: next,
      },
    })
  }

  const handleCapabilityOverride = (key: RoutingCapabilityKey, next: RouteOverridePolicy): void => {
    const capabilityOverrides: CapabilityRoutingOverrides = {
      ...status.routing.capabilityOverrides,
      [key]: next,
    }
    void onUpdateRouting({ capabilityOverrides })
  }

  return (
    <div className={css.section}>
      <header className={css.header}>
        <h2 className={css.title}>{t('section.title')}</h2>
        <p className={css.subtitle}>{t('section.subtitle')}</p>
      </header>

      {view.error !== null && (
        <div className={css.errorBanner} role="alert">
          <span className={css.errorText}>{view.error}</span>
          <Button size="sm" variant="ghost" onClick={onClearError}>
            {t('error.dismiss')}
          </Button>
        </div>
      )}

      {/* 1. Outbound proxy mode & loopback gateway */}
      <SettingsCard title={t('mode.title')}>
        <SegmentedControl
          id={modeControlId}
          value={status.mode}
          options={modeOptions}
          label={t('mode.label')}
          disabled={view.loading}
          onChange={(next) => { void onSetMode(next) }}
        />
        <div
          id={`${modeControlId}-${status.mode}-panel`}
          role="tabpanel"
          aria-labelledby={`${modeControlId}-${status.mode}`}
          className={css.modePanel}
        >
          <p className={css.modeDesc}>{modeDescription}</p>
          <div className={css.gatewayRow}>
            <span className={css.gatewayStatus}>
              <StateDot
                state={status.gateway !== null ? 'done' : 'idle'}
                size={8}
              />
              {status.gateway !== null
                ? t('gateway.running', { url: status.gateway.httpProxyUrl })
                : t('gateway.stopped')}
            </span>
            <span>
              {selectedNode !== null
                ? t('gateway.activeNode', { name: selectedNode.name })
                : t('gateway.noNode')}
            </span>
          </div>
        </div>
      </SettingsCard>

      {/* 2. VPN subscriptions */}
      <SettingsCard
        title={t('subs.title')}
        description={t('subs.desc')}
        actions={(
          <>
            <Button
              size="sm"
              variant="outline"
              icon={<IconRefreshOutlineRegular size={16} />}
              disabled={view.loading || status.subscriptions.length === 0}
              onClick={() => { void onRefreshSubscriptions() }}
            >
              {t('subs.refreshAll')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlusOutlineRegular size={16} />}
              disabled={view.loading}
              onClick={openAddDraft}
            >
              {t('subs.add')}
            </Button>
          </>
        )}
      >

        {unimportedEnvCandidates.length > 0 && (
          <div className={css.envBanner}>
            <div className={css.envBannerInfo}>
              <span className={css.envBannerTitle}>
                {t('subs.envBannerTitle', { count: String(unimportedEnvCandidates.length) })}
              </span>
              <div className={css.envCandidateList}>
                {unimportedEnvCandidates.map(cand => (
                  <span key={`${cand.source}:${cand.envKey}`}>
                    {`${cand.envKey} (${cand.maskedUrl})`}
                  </span>
                ))}
              </div>
            </div>
            <Button
              size="sm"
              variant="primary"
              disabled={view.loading}
              onClick={() => { void onImportEnv() }}
            >
              {t('subs.envBannerAction')}
            </Button>
          </div>
        )}

        {draft !== null && (
          <div className={css.formBox}>
            <h4 className={css.formTitle}>
              {draft.mode === 'add'
                ? t('subs.form.addTitle')
                : t('subs.form.editTitle', { name: draft.targetName })}
            </h4>
            <div className={css.fieldGrid}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('subs.form.nameLabel')}</span>
                <Input
                  value={draft.name}
                  placeholder={t('subs.form.namePlaceholder')}
                  aria-label={t('subs.form.nameLabel')}
                  onChange={(e) => { setDraft({ ...draft, name: e.target.value }) }}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('subs.form.refreshLabel')}</span>
                <Input
                  type="number"
                  value={draft.autoRefreshMinutes}
                  aria-label={t('subs.form.refreshLabel')}
                  onChange={(e) => { setDraft({ ...draft, autoRefreshMinutes: e.target.value }) }}
                />
              </label>
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('subs.form.urlLabel')}</span>
              <Input
                type="password"
                autoComplete="off"
                value={draft.url}
                placeholder={draft.mode === 'add' ? t('subs.form.urlPlaceholderAdd') : t('subs.form.urlPlaceholderEdit')}
                aria-label={t('subs.form.urlLabel')}
                onChange={(e) => { setDraft({ ...draft, url: e.target.value }) }}
              />
            </label>
            <div className={css.toggleRow}>
              <span className={css.toggleText}>{t('subs.form.enabledLabel')}</span>
              <Switch
                checked={draft.enabled}
                label={t('subs.form.enabledLabel')}
                onChange={(next) => { setDraft({ ...draft, enabled: next }) }}
              />
            </div>
            <div className={css.formFooter}>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(null) }}>
                {t('subs.form.cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={view.loading}
                onClick={() => { void submitSubscriptionDraft(draft) }}
              >
                {t('subs.form.save')}
              </Button>
            </div>
          </div>
        )}

        {status.subscriptions.length === 0 ? (
          <p className={css.emptyText}>{t('subs.empty')}</p>
        ) : (
          <ul className={css.itemList}>
            {status.subscriptions.map((sub) => {
              const quota = formatByteQuota(sub.userInfo)
              return (
                <li key={sub.id} className={css.subRow}>
                  <div className={css.subRowTop}>
                    <div className={css.subIdentity}>
                      <span className={css.subName}>{sub.name}</span>
                      <Tag tone={sub.enabled ? 'success' : 'neutral'}>
                        {t('subs.nodesCount', { count: String(sub.nodeCount) })}
                      </Tag>
                      {sub.envKey !== undefined && (
                        <Tag tone="info">{t('subs.envBadge', { key: sub.envKey })}</Tag>
                      )}
                    </div>
                    <div className={css.subControls}>
                      <Switch
                        checked={sub.enabled}
                        label={t('subs.toggleLabel', { name: sub.name })}
                        disabled={view.loading}
                        onChange={(next) => {
                          void onUpdateSubscription({ id: sub.id, enabled: next })
                        }}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconRefreshOutlineRegular size={16} />}
                        disabled={view.loading || !sub.enabled}
                        onClick={() => { void onRefreshSubscriptions(sub.id) }}
                      >
                        {t('subs.refreshOne')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconEditOutlineRegular size={16} />}
                        disabled={view.loading}
                        onClick={() => { openEditDraft(sub) }}
                      >
                        {t('subs.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconTrashOutlineRegular size={16} />}
                        disabled={view.loading}
                        onClick={() => { void onRemoveSubscription(sub.id) }}
                      >
                        {t('subs.remove')}
                      </Button>
                    </div>
                  </div>
                  <div className={css.subMeta}>
                    <span>{sub.maskedUrl}</span>
                    {quota !== null && (
                      <span>{t('subs.quota', { used: quota.usedGib, total: quota.totalGib })}</span>
                    )}
                  </div>
                  {sub.lastError !== undefined && (
                    <p className={css.subError}>{sub.lastError}</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </SettingsCard>

      {/* 3. Smart routing & overrides */}
      <SettingsCard title={t('routing.title')} description={t('routing.desc')}>

        <div className={css.fieldGrid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('routing.preferRegionLabel')}</span>
            <Input
              value={preferRegion}
              placeholder={t('routing.preferRegionPlaceholder')}
              aria-label={t('routing.preferRegionLabel')}
              onChange={(e) => { setPreferRegion(e.target.value) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('routing.maxLatencyLabel')}</span>
            <Input
              type="number"
              value={maxLatencyText}
              aria-label={t('routing.maxLatencyLabel')}
              onChange={(e) => { setMaxLatencyText(e.target.value) }}
            />
          </label>
        </div>

        <div className={css.toggleRow}>
          <span className={css.toggleText}>{t('routing.subprocessesLabel')}</span>
          <Switch
            checked={status.routing.proxySubprocesses}
            label={t('routing.subprocessesLabel')}
            disabled={view.loading}
            onChange={(next) => { void onUpdateRouting({ proxySubprocesses: next }) }}
          />
        </div>

        <div className={css.toggleRow}>
          <span className={css.toggleText}>{t('routing.browserGuestsLabel')}</span>
          <Switch
            checked={status.routing.proxyBrowserGuests}
            label={t('routing.browserGuestsLabel')}
            disabled={view.loading}
            onChange={(next) => { void onUpdateRouting({ proxyBrowserGuests: next }) }}
          />
        </div>

        <h4 className={css.subGroupHeading}>{t('routing.providersHeading')}</h4>
        <div className={css.overrideList}>
          {PROVIDER_ROWS.map((row) => {
            const currentPolicy = status.routing.providerOverrides[row.id] ?? 'auto'
            return (
              <div key={row.id} className={css.overrideRow}>
                <span className={css.overrideLabel}>{t(row.labelKey)}</span>
                <SegmentedControl
                  id={`${baseId}-prov-${row.id}`}
                  value={currentPolicy}
                  options={overrideOptions}
                  label={t(row.labelKey)}
                  disabled={view.loading}
                  className={css.overrideSegment}
                  onChange={(next) => { handleProviderOverride(row.id, next) }}
                />
              </div>
            )
          })}
        </div>

        <h4 className={css.subGroupHeading}>{t('routing.capabilitiesHeading')}</h4>
        <div className={css.overrideList}>
          {CAPABILITY_ROWS.map((row) => {
            const currentPolicy = status.routing.capabilityOverrides[row.key] ?? 'auto'
            return (
              <div key={row.key} className={css.overrideRow}>
                <span className={css.overrideLabel}>{t(row.labelKey)}</span>
                <SegmentedControl
                  id={`${baseId}-cap-${row.key}`}
                  value={currentPolicy}
                  options={overrideOptions}
                  label={t(row.labelKey)}
                  disabled={view.loading}
                  className={css.overrideSegment}
                  onChange={(next) => { handleCapabilityOverride(row.key, next) }}
                />
              </div>
            )
          })}
        </div>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('routing.customRulesLabel')}</span>
          <textarea
            className={css.rulesTextarea}
            value={customRulesText}
            placeholder={t('routing.customRulesPlaceholder')}
            aria-label={t('routing.customRulesLabel')}
            onChange={(e) => { setCustomRulesText(e.target.value) }}
          />
        </label>

        <div className={css.formFooter}>
          <Button
            size="sm"
            variant="primary"
            disabled={view.loading}
            onClick={() => { void saveRoutingForm() }}
          >
            {t('routing.save')}
          </Button>
        </div>
      </SettingsCard>

      {/* 4. Node leaderboard & selection */}
      <SettingsCard
        title={t('nodes.title')}
        description={t('nodes.desc')}
        actions={(
          <Button
            size="sm"
            variant="outline"
            icon={<IconRefreshOutlineRegular size={16} />}
            disabled={view.probing || status.nodes.length === 0}
            onClick={() => { void onProbeNodes() }}
          >
            {view.probing ? t('nodes.probing') : t('nodes.probe')}
          </Button>
        )}
      >

        {status.nodes.length === 0 ? (
          <p className={css.emptyText}>{t('nodes.empty')}</p>
        ) : (
          <div className={css.itemList}>
            <button
              type="button"
              className={clsx(css.nodeButton, status.pinnedNodeId === null && css.nodeButtonSelected)}
              disabled={view.loading}
              onClick={() => { void onSelectNode(null) }}
            >
              <span className={css.nodeIdentity}>
                <span className={css.nodeName}>{t('nodes.autoSelect')}</span>
              </span>
              {status.pinnedNodeId === null && (
                <span className={css.nodeBadges}>
                  <Tag tone="solid">{t('nodes.activeBadge')}</Tag>
                </span>
              )}
            </button>

            {status.nodes.map((node) => {
              const isPinned = status.pinnedNodeId === node.nodeId
              const isActive = status.selectedNodeId === node.nodeId
              const rtt = node.latencyMs
              return (
                <button
                  key={node.nodeId}
                  type="button"
                  className={clsx(css.nodeButton, isActive && css.nodeButtonSelected)}
                  disabled={view.loading}
                  onClick={() => { void onSelectNode(node.nodeId) }}
                >
                  <span className={css.nodeIdentity}>
                    <Tag tone="neutral">{node.protocol.toUpperCase()}</Tag>
                    <span className={css.nodeName}>{node.name}</span>
                  </span>
                  <span className={css.nodeBadges}>
                    {node.circuitOpenUntilMs !== null && (
                      <Tag tone="warning">{t('nodes.circuitOpen')}</Tag>
                    )}
                    {isPinned && <Tag tone="info">{t('nodes.pinnedBadge')}</Tag>}
                    {isActive && <Tag tone="solid">{t('nodes.activeBadge')}</Tag>}
                    <Tag tone={rtt !== null ? 'success' : 'outline'}>
                      {rtt !== null
                        ? t('nodes.latencyMs', { ms: String(Math.round(rtt)) })
                        : t('nodes.untested')}
                    </Tag>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </SettingsCard>

      {/* 5. 1-click connectivity diagnostics */}
      <SettingsCard
        title={t('diag.title')}
        description={t('diag.desc')}
        actions={(
          <Button
            size="sm"
            variant="primary"
            disabled={view.diagnosing}
            onClick={() => { void onRunDiagnostics() }}
          >
            {view.diagnosing ? t('diag.running') : t('diag.run')}
          </Button>
        )}
      >

        {view.diagnostics === null ? (
          <p className={css.emptyText}>{t('diag.empty')}</p>
        ) : (
          <ul className={css.itemList}>
            {view.diagnostics.targets.map((target) => {
              const routeLabel = target.route === 'direct'
                ? t('diag.route.direct')
                : target.route === 'proxy'
                  ? t('diag.route.proxy')
                  : t('diag.route.reject')
              const routeTone = target.route === 'proxy'
                ? 'info'
                : target.route === 'direct'
                  ? 'neutral'
                  : 'warning'
              return (
                <li key={target.id} className={css.diagRow}>
                  <div className={css.diagIdentity}>
                    <StateDot state={target.ok ? 'done' : 'error'} size={8} />
                    <span className={css.diagLabel}>{target.label}</span>
                    <Tag tone={routeTone}>{routeLabel}</Tag>
                    {target.nodeName !== undefined && (
                      <span className={css.diagMeta}>
                        {t('diag.viaNode', { node: target.nodeName })}
                      </span>
                    )}
                  </div>
                  <div className={css.diagMeta}>
                    {target.statusCode !== undefined && (
                      <Tag tone={target.ok ? 'success' : 'danger'}>
                        {t('diag.statusHttp', { code: String(target.statusCode) })}
                      </Tag>
                    )}
                    {target.latencyMs !== null && (
                      <span>{t('nodes.latencyMs', { ms: String(Math.round(target.latencyMs)) })}</span>
                    )}
                    {target.error !== undefined && (
                      <span className={css.diagError}>{target.error}</span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </SettingsCard>
    </div>
  )
}
