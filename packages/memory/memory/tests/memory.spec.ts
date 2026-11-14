import { Context } from '@deepseek-ai/cordis'
import EmbeddingRuntime from '@deepseek-ai/dsh-embedding'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageSqlitePlugin from '@deepseek-ai/dsh-storage-sqlite'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import MemoryService, { MemoryInputError } from '../src/index.ts'
import {
  DEFAULT_MEMORY_PREFERENCES,
  MemoryId,
  compareCanonicalContextOrder,
  compareCatalogRecords,
  containsSensitiveSecret,
  monotonicTimestamp,
  normalizeMemoryContent,
  normalizeMemoryScope,
  normalizeWorkspacePath,
  sameMemoryScope,
  validateMemoryCategory,
} from '../src/domain.ts'
import { renderMemorySnapshot, selectMemoriesForContext, tokenizeForRelevance } from '../src/selector.ts'
import type { MemoryCategory, MemoryRecord, MemoryScope } from '../src/types.ts'

async function startHarness(config?: ConstructorParameters<typeof MemoryService>[1], withEmbedding = false) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageSqlitePlugin, { path: ':memory:' })
  await ctx.plugin(storageDomainPlugin, { backend: 'sqlite' })
  if (withEmbedding) await ctx.plugin(EmbeddingRuntime)
  await ctx.plugin(MemoryService, config)
  return ctx
}

describe('memory domain helpers', () => {
  it('validates content, categories, scopes, secrets, timestamps, and comparators', () => {
    const err = new MemoryInputError('invalid_content', 'bad', { cause: new Error('inner') })
    expect(err.reason).toBe('invalid_content')
    expect(err.code).toBe('MEMORY_INVALID_CONTENT')

    expect(containsSensitiveSecret('sk-proj1234567890abcdef1234')).toBe(true)
    expect(containsSensitiveSecret('ghp_1234567890abcdefghij12345')).toBe(true)
    expect(containsSensitiveSecret('AKIA1234567890ABCDEF')).toBe(true)
    expect(containsSensitiveSecret('Bearer abcdefghijklmnopqrstuvwx')).toBe(true)
    expect(containsSensitiveSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    expect(containsSensitiveSecret('api_key = "supersecretvalue123"')).toBe(true)
    expect(containsSensitiveSecret('User prefers concise bullet points.')).toBe(false)

    expect(normalizeMemoryContent('  hello\r\nworld  ', 64)).toBe('hello\nworld')
    expect(() => normalizeMemoryContent('   ', 64)).toThrow(MemoryInputError)
    expect(() => normalizeMemoryContent('x'.repeat(80), 64)).toThrow(MemoryInputError)
    expect(() => normalizeMemoryContent('token sk-1234567890abcdefghij', 256)).toThrow(MemoryInputError)

    expect(validateMemoryCategory('preference')).toBe('preference')
    expect(() => validateMemoryCategory('unknown' as MemoryCategory)).toThrow(MemoryInputError)

    expect(normalizeWorkspacePath(' /repo/app/// ')).toBe('/repo/app')
    expect(normalizeWorkspacePath('/')).toBe('/')
    expect(normalizeWorkspacePath('C:\\')).toBe('C:\\')
    expect(() => normalizeWorkspacePath('   ')).toThrow(MemoryInputError)

    expect(normalizeMemoryScope({ kind: 'global' })).toEqual({ kind: 'global' })
    expect(normalizeMemoryScope({ kind: 'workspace', workspacePath: '/tmp/ws/' })).toEqual({
      kind: 'workspace',
      workspacePath: '/tmp/ws',
    })
    expect(() => normalizeMemoryScope({ kind: 'other' } as never)).toThrow(MemoryInputError)

    const futureIso = '2030-01-01T00:00:00.500Z'
    expect(monotonicTimestamp(undefined, Date.parse('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01T00:00:00.000Z')
    expect(monotonicTimestamp(futureIso, Date.parse('2026-01-01T00:00:00.000Z'))).toBe('2030-01-01T00:00:00.501Z')

    const globalScope: MemoryScope = { kind: 'global' }
    const wsA: MemoryScope = { kind: 'workspace', workspacePath: '/a' }
    const wsB: MemoryScope = { kind: 'workspace', workspacePath: '/b' }
    expect(sameMemoryScope(globalScope, globalScope)).toBe(true)
    expect(sameMemoryScope(wsA, { kind: 'workspace', workspacePath: '/a' })).toBe(true)
    expect(sameMemoryScope(wsA, wsB)).toBe(false)
    expect(sameMemoryScope(globalScope, wsA)).toBe(false)

    const baseRecord = (overrides: Partial<MemoryRecord>): MemoryRecord => ({
      id: MemoryId('mem-1'),
      content: 'Note',
      category: 'fact',
      scope: globalScope,
      source: { kind: 'user' },
      status: 'active',
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    })

    const rActivePinned = baseRecord({ id: MemoryId('mem-a'), pinned: true })
    const rActiveNew = baseRecord({ id: MemoryId('mem-b'), updatedAt: '2026-01-02T00:00:00.000Z' })
    const rActiveOldA = baseRecord({ id: MemoryId('mem-c'), category: 'profile' })
    const rActiveOldB = baseRecord({ id: MemoryId('mem-d'), category: 'workflow', scope: wsA })
    const rPaused = baseRecord({ id: MemoryId('mem-e'), status: 'paused' })
    const rSuperseded = baseRecord({ id: MemoryId('mem-f'), status: 'superseded' })

    const catalogSorted = [rSuperseded, rPaused, rActiveOldB, rActiveOldA, rActiveNew, rActivePinned]
      .sort(compareCatalogRecords)
    expect(catalogSorted.map(item => item.id)).toEqual([
      'mem-a',
      'mem-b',
      'mem-c',
      'mem-d',
      'mem-e',
      'mem-f',
    ])

    const canonicalSorted = [
      baseRecord({ id: MemoryId('mem-4'), scope: wsA, category: 'fact' }),
      baseRecord({ id: MemoryId('mem-3'), scope: globalScope, category: 'fact' }),
      baseRecord({ id: MemoryId('mem-2'), scope: globalScope, category: 'fact' }),
      baseRecord({ id: MemoryId('mem-1'), scope: globalScope, category: 'profile' }),
      rActivePinned,
    ].sort(compareCanonicalContextOrder)
    expect(canonicalSorted.map(item => item.id)).toEqual([
      'mem-a',
      'mem-1',
      'mem-2',
      'mem-3',
      'mem-4',
    ])
  })
})

describe('memory selector', () => {
  it('tokenizes CJK single/multi runs and Latin words, fuses dense vectors, and enforces budgets', async () => {
    expect(tokenizeForRelevance('   ').size).toBe(0)
    const singleCjk = tokenizeForRelevance('中 a')
    expect(singleCjk.has('中')).toBe(true)
    expect(singleCjk.has('a')).toBe(true)
    const multiCjk = tokenizeForRelevance('深色模式，图表配色!')
    expect(multiCjk.has('深色')).toBe(true)
    expect(multiCjk.has('图表')).toBe(true)

    expect(renderMemorySnapshot([])).toBe('')
    expect(await selectMemoriesForContext([], { maxInjectEntries: 10, maxInjectBytes: 4096 })).toEqual({
      digest: '',
      formattedText: '',
      items: [],
    })

    const mk = (
      id: string,
      content: string,
      extra: Partial<MemoryRecord> = {},
    ): MemoryRecord => ({
      id: MemoryId(id),
      content,
      category: 'preference',
      scope: { kind: 'global' },
      source: { kind: 'user' },
      status: 'active',
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    })

    const rPunctuation = mk('m-punct', '---', { source: { kind: 'tool' } })
    const rAuto = mk('m-auto', '所有报告默认使用中文撰写', {
      source: { kind: 'auto', sessionId: SessionId('sess-auto') },
    })
    const rToolWithSess = mk('m-tool', '图表配色保持克制低饱和', {
      scope: { kind: 'workspace', workspacePath: '/ws' },
      source: { kind: 'tool', sessionId: SessionId('sess-tool') },
    })
    const rPinned = mk('m-pin', 'Core identity\nline two', { pinned: true })

    // Tiny byte budget admits nothing when even the smallest item overflows.
    const emptyDueToBytes = await selectMemoriesForContext([rAuto], {
      queryText: '报告',
      maxInjectEntries: 5,
      maxInjectBytes: 64,
    })
    expect(emptyDueToBytes.items).toEqual([])

    // Oversized item is skipped while compact item still fits, and maxInjectEntries caps count.
    const longItem = mk('m-long', 'long '.repeat(120))
    const partialFit = await selectMemoriesForContext([rPinned, longItem, rAuto, rToolWithSess, rPunctuation], {
      queryText: '图表 报告',
      maxInjectEntries: 3,
      maxInjectBytes: 420,
    })
    expect(partialFit.items.map(item => item.id)).toContain('m-pin')
    expect(partialFit.items.map(item => item.id)).not.toContain('m-long')
    expect(partialFit.formattedText).toContain('Core identity line two')

    // Canonical digest stays identical across different query wordings when the admitted set is unchanged.
    const sel1 = await selectMemoriesForContext([rAuto, rToolWithSess, rPunctuation], {
      queryText: 'v2版中文报告',
      maxInjectEntries: 10,
      maxInjectBytes: 4096,
    })
    const sel2 = await selectMemoriesForContext([rAuto, rToolWithSess, rPunctuation], {
      queryText: '图表配色',
      maxInjectEntries: 10,
      maxInjectBytes: 4096,
    })
    expect(sel1.digest).toBe(sel2.digest)
    expect(sel1.items.find(i => i.id === 'm-auto')?.sourceSessionId).toBe('sess-auto')
    expect(sel1.items.find(i => i.id === 'm-tool')?.sourceSessionId).toBe('sess-tool')
    expect(sel1.items.find(i => i.id === 'm-punct')?.sourceSessionId).toBeUndefined()

    // Dense embedding RRF fusion, mismatched vector fallback, and throwing provider fallback.
    const ctx = await startHarness(undefined, true)
    try {
      // Unavailable provider path.
      const noProviderSel = await selectMemoriesForContext([rAuto, rToolWithSess], {
        queryText: '   ',
        embedding: ctx.embedding,
        maxInjectEntries: 10,
        maxInjectBytes: 4096,
      })
      expect(noProviderSel.items).toHaveLength(2)

      // Working provider path with tie-breakers.
      const disposeWorking = ctx.embedding.registerProvider({
        modelId: 'mock-dense',
        embed: async texts => texts.map((_, index) => new Float32Array([index === 2 ? 1 : 0.5, index === 2 ? 0 : 0.5])),
      })
      const rTieA = mk('m-tie-a', 'alpha beta', { updatedAt: '2026-01-01T00:00:00.000Z' })
      const rTieB = mk('m-tie-b', 'alpha beta', { updatedAt: '2026-01-01T00:00:00.000Z' })
      const controller = new AbortController()
      const denseSel = await selectMemoriesForContext([rTieA, rTieB, rToolWithSess], {
        queryText: 'semantic query',
        embedding: ctx.embedding,
        signal: controller.signal,
        maxInjectEntries: 2,
        maxInjectBytes: 4096,
      })
      expect(denseSel.items).toHaveLength(2)
      const emptyQueryWithProvider = await selectMemoriesForContext([rTieA, rTieB], {
        queryText: '   ',
        embedding: ctx.embedding,
        maxInjectEntries: 2,
        maxInjectBytes: 4096,
      })
      expect(emptyQueryWithProvider.items).toHaveLength(2)
      disposeWorking()

      // Throwing provider path degrades cleanly to lexical scoring.
      const disposeFailing = ctx.embedding.registerProvider({
        modelId: 'failing-dense',
        embed: async () => {
          throw new Error('network down')
        },
      })
      const fallbackSel = await selectMemoriesForContext([rAuto, rToolWithSess], {
        queryText: '中文报告',
        embedding: ctx.embedding,
        maxInjectEntries: 1,
        maxInjectBytes: 4096,
      })
      expect(fallbackSel.items.map(item => item.id)).toEqual(['m-auto'])
      disposeFailing()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('MemoryService', () => {
  it('handles pre-init reads, CRUD, deduplication, supersede, policies, Remote errors, and teardown', async () => {
    const rawCtx = new Context()
    await rawCtx.plugin(Storage)
    await rawCtx.plugin(storageSqlitePlugin, { path: ':memory:' })
    await rawCtx.plugin(storageDomainPlugin, { backend: 'sqlite' })
    const unstartedService = new MemoryService(rawCtx)
    expect(unstartedService.isSessionIncognito(SessionId('s-pre'))).toBe(false)
    expect(unstartedService.getPreferences()).toEqual(DEFAULT_MEMORY_PREFERENCES)
    expect(unstartedService.getSessionPolicy({ sessionId: SessionId('s-pre') })).toEqual({
      sessionId: SessionId('s-pre'),
      incognito: false,
      updatedAt: '',
    })
    await unstartedService.catalog()
    await rawCtx.fiber.dispose()

    const ctx = await startHarness({
      maxEntries: 3,
      maxEntryBytes: 256,
      maxInjectEntries: 10,
      maxInjectBytes: 4096,
    }, true)

    let changedCount = 0
    ctx.on('memory/changed', () => {
      changedCount += 1
      if (changedCount === 1) throw new Error('observer boom')
    })

    // Unrelated domain event is ignored by MemoryService's domain/changed listener.
    ctx.emit('domain/changed', {
      domain: 'other-domain',
      table: 't',
      key: 'k',
      operation: 'put',
      value: {},
    })
    expect(changedCount).toBe(0)

    expect(ctx.memory.containsSensitiveContent('sk-1234567890abcdefghij')).toBe(true)
    expect(ctx.memory.containsSensitiveContent('normal note')).toBe(false)

    // Create + duplicate merge in same scope.
    const createdGlobal = await ctx.memory.remoteCreate({
      content: 'Prefer Markdown deliverables with tables.',
      category: 'preference',
      scope: { kind: 'global' },
      pinned: true,
    })
    expect(changedCount).toBe(1)
    expect(createdGlobal.pinned).toBe(true)
    expect(createdGlobal.source).toEqual({ kind: 'user' })

    const dedupedGlobal = await ctx.memory.create({
      content: '  prefer   markdown deliverables with tables. ',
      category: 'workflow',
      scope: { kind: 'global' },
    })
    expect(dedupedGlobal.id).toBe(createdGlobal.id)
    expect(dedupedGlobal.category).toBe('workflow')
    expect(dedupedGlobal.pinned).toBe(true)

    const createdWs = await ctx.memory.create({
      content: 'Use pnpm offline in this workspace.',
      category: 'constraint',
      scope: { kind: 'workspace', workspacePath: '/projects/alpha/' },
      source: { kind: 'auto', sessionId: SessionId('sess-1') },
    })
    const createdOtherWs = await ctx.memory.create({
      content: 'Python data pipeline conventions.',
      category: 'fact',
      scope: { kind: 'workspace', workspacePath: '/projects/beta' },
    })

    // Capacity limit reached (3 live entries).
    await expect(ctx.memory.remoteCreate({
      content: 'Fourth entry exceeding cap',
      category: 'fact',
      scope: { kind: 'global' },
    })).rejects.toThrow(RemoteError)

    // Catalog filters & queries.
    const allCatalog = await ctx.memory.catalog()
    expect(allCatalog.items).toHaveLength(3)
    expect((await ctx.memory.remoteCatalog({ scopeKind: 'global' })).items).toHaveLength(1)
    expect((await ctx.memory.remoteCatalog({ scopeKind: 'workspace' })).items).toHaveLength(2)
    expect((await ctx.memory.remoteCatalog({ scopeKind: 'workspace', workspacePath: '/projects/alpha' })).items)
      .toHaveLength(1)
    expect((await ctx.memory.remoteCatalog({ scopeKind: 'applicable', workspacePath: '/projects/alpha' })).items)
      .toHaveLength(2)
    expect((await ctx.memory.remoteCatalog({ scopeKind: 'applicable', workspacePath: '   ' })).items)
      .toHaveLength(1)
    expect((await ctx.memory.remoteCatalog({ category: 'constraint' })).items).toHaveLength(1)
    expect((await ctx.memory.remoteCatalog({ query: 'markdown' })).items).toHaveLength(1)
    expect((await ctx.memory.remoteCatalog({ query: 'deliverables tables' })).items).toHaveLength(1)
    expect((await ctx.memory.remoteCatalog({ query: 'deliverables nonexistent' })).items).toHaveLength(0)
    expect((await ctx.memory.remoteCatalog({ query: '   ' })).items).toHaveLength(3)
    expect((await ctx.memory.remoteCatalog({ query: '!!!' })).items).toHaveLength(3)

    await expect(ctx.memory.remoteCatalog({ scopeKind: 'workspace', workspacePath: '/' })).resolves.toBeDefined()

    // Update: empty patch, not found, conflict, valid update.
    await expect(ctx.memory.remoteUpdate({ id: createdWs.id, patch: {} })).rejects.toThrow(RemoteError)
    expect(await ctx.memory.remoteUpdate({
      id: MemoryId('mem-missing'),
      patch: { pinned: true },
    })).toEqual({ id: 'mem-missing', code: 'memory_not_found' })
    expect(await ctx.memory.remoteUpdate({
      id: createdWs.id,
      patch: { pinned: true },
      expectedUpdatedAt: '1999-01-01T00:00:00.000Z',
    })).toEqual({ id: createdWs.id, code: 'memory_conflict' })

    const updatedWs = await ctx.memory.remoteUpdate({
      id: createdWs.id,
      patch: {
        content: 'Always pass --offline to pnpm install in alpha.',
        category: 'workflow',
        scope: { kind: 'workspace', workspacePath: '/projects/alpha' },
        pinned: true,
        status: 'paused',
      },
      expectedUpdatedAt: createdWs.updatedAt,
    })
    expect('content' in updatedWs && updatedWs.status).toBe('paused')
    const partialUpdatedOther = await ctx.memory.update({
      id: createdOtherWs.id,
      patch: { pinned: false },
    })
    expect('content' in partialUpdatedOther && partialUpdatedOther.content).toBe('Python data pipeline conventions.')

    // Supersede live entry (preserves live count = 3 and inherits pinned).
    const replacement = await ctx.memory.supersede({
      targetId: createdWs.id,
      content: 'Run pnpm install --offline across alpha scripts.',
      category: 'workflow',
      scope: { kind: 'workspace', workspacePath: '/projects/alpha' },
      source: { kind: 'auto', sessionId: SessionId('sess-2') },
    })
    expect(replacement.pinned).toBe(true)
    expect(await ctx.memory.update({
      id: createdWs.id,
      patch: { status: 'active' },
    })).toEqual({ id: createdWs.id, code: 'memory_superseded' })

    // Superseding an already-superseded target while at capacity rejects with capacity_exceeded.
    await expect(ctx.memory.supersede({
      targetId: createdWs.id,
      content: 'Extra entry over cap',
      category: 'fact',
      scope: { kind: 'global' },
      source: { kind: 'user' },
    })).rejects.toThrow(MemoryInputError)

    const withSuperseded = await ctx.memory.catalog({ includeSuperseded: true })
    expect(withSuperseded.items).toHaveLength(4)
    expect((await ctx.memory.catalog()).items).toHaveLength(3)

    // Supersede with explicit pinned=false override.
    const unpinnedReplacement = await ctx.memory.supersede({
      targetId: replacement.id,
      content: 'Run pnpm install --offline across all alpha scripts.',
      category: 'workflow',
      scope: { kind: 'workspace', workspacePath: '/projects/alpha' },
      source: { kind: 'user' },
      pinned: false,
    })
    expect(unpinnedReplacement.pinned).toBe(false)

    // Delete + supersede missing target when under capacity.
    expect(await ctx.memory.delete({ id: createdOtherWs.id })).toEqual({ id: createdOtherWs.id, deleted: true })
    expect(await ctx.memory.delete({ id: MemoryId('mem-absent') })).toEqual({ id: 'mem-absent', deleted: false })

    const fallbackReplacement = await ctx.memory.supersede({
      targetId: MemoryId('mem-absent'),
      content: 'Created directly when target is absent.',
      category: 'fact',
      scope: { kind: 'global' },
      source: { kind: 'user' },
    })
    expect(fallbackReplacement.pinned).toBe(false)

    // Deduplication ignores superseded entries and creates fresh entry when room exists.
    await ctx.memory.delete({ id: fallbackReplacement.id })
    const recreatedAfterSupersede = await ctx.memory.create({
      content: 'Always pass --offline to pnpm install in alpha.',
      category: 'workflow',
      scope: { kind: 'workspace', workspacePath: '/projects/alpha' },
    })
    expect(recreatedAfterSupersede.id).not.toBe(createdWs.id)

    // Preferences & session incognito policies + selectForContext behavior.
    const sessionId = SessionId('sess-incog')
    expect(ctx.memory.getSessionPolicy({ sessionId }).incognito).toBe(false)
    const policy1 = await ctx.memory.setSessionPolicy({ sessionId, incognito: true })
    expect(policy1.incognito).toBe(true)
    expect(ctx.memory.getSessionPolicy({ sessionId }).incognito).toBe(true)
    expect(ctx.memory.isSessionIncognito(sessionId)).toBe(true)
    const policy2 = await ctx.memory.setSessionPolicy({ sessionId, incognito: true })
    expect(Date.parse(policy2.updatedAt)).toBeGreaterThanOrEqual(Date.parse(policy1.updatedAt))

    // Default incognitoIsolatesRead=false still allows read selection.
    const defaultSel = await ctx.memory.selectForContext()
    expect(defaultSel.items.length).toBeGreaterThan(0)
    const incogReadAllowed = await ctx.memory.selectForContext({
      sessionId,
      workspacePath: '/projects/alpha',
      queryText: 'pnpm offline',
      signal: new AbortController().signal,
    })
    expect(incogReadAllowed.items.length).toBeGreaterThan(0)

    // Enabling incognitoIsolatesRead suppresses reads for incognito sessions only.
    const prefsIsolate = await ctx.memory.setPreferences({ incognitoIsolatesRead: true })
    expect(prefsIsolate.incognitoIsolatesRead).toBe(true)
    expect((await ctx.memory.selectForContext({ sessionId, workspacePath: '/projects/alpha' })).items).toEqual([])
    expect((await ctx.memory.selectForContext({
      sessionId: SessionId('sess-normal'),
      workspacePath: '   ',
    })).items.length).toBeGreaterThan(0)

    // Disabling autoInjectEnabled suppresses all context selections.
    await ctx.memory.setPreferences({ autoInjectEnabled: false, autoExtractEnabled: false })
    expect(ctx.memory.getPreferences().autoExtractEnabled).toBe(false)
    expect((await ctx.memory.selectForContext({ workspacePath: '/projects/alpha' })).items).toEqual([])

    // Clear scope: workspace, invalid scope via Remote, and all.
    expect(await ctx.memory.remoteClearScope({
      scope: { kind: 'workspace', workspacePath: '/projects/alpha' },
    })).toEqual({ deleted: 4 })
    await expect(ctx.memory.remoteClearScope({
      scope: { kind: 'workspace', workspacePath: '   ' },
    })).rejects.toThrow(RemoteError)
    expect(await ctx.memory.remoteClearScope({ scope: { kind: 'all' } })).toEqual({ deleted: 1 })

    // Non-MemoryInputError thrown inside internal method propagates unchanged through Remote wrapper.
    const originalCatalog = ctx.memory.catalog.bind(ctx.memory)
    ctx.memory.catalog = async () => {
      throw new TypeError('unexpected failure')
    }
    await expect(ctx.memory.remoteCatalog({})).rejects.toThrow(TypeError)
    ctx.memory.catalog = originalCatalog

    const stoppedMem = ctx.memory
    await ctx.fiber.dispose()
    await expect(stoppedMem.delete({ id: createdGlobal.id })).rejects.toThrow('Memory service is stopping')
  })
})
