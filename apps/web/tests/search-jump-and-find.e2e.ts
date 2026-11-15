// End-to-end browser verification for M2.4: rich sidebar search snippets and
// match counts, persistent search list on click, cross-page jump-to-match with
// collapsed-process auto-expansion, lossless CSS Custom Highlight API ranges,
// and In-Session Find (Cmd/Ctrl+F) synchronized with Turn Rail markers.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const TURNS = 64
const SEED_ID = 'search-jump-and-find-web-e2e'
const FIXTURE = createChatScrollFixture({
  markerPrefix: 'SEARCHJUMP',
  title: 'Search jump and in-session find',
  turns: TURNS,
})

describe('web e2e: sidebar jump-to-match, CSS.highlights, and in-session find', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, FIXTURE.log, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' })
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('jumps from a cold sidebar content match across pages while keeping search open, then navigates via Cmd+F and Turn Rail', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-jump-and-find'))

    // 1. Rich sidebar search: multi-match count badge + <mark> snippet highlights.
    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    const sidebarSearch = page.getByRole('textbox', { name: 'Search titles or messages…', exact: true })
    await sidebarSearch.fill('accounted')
    const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await expect.poll(() => results.count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => results.locator('mark').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(() => results.textContent(), { timeout: 10_000 }).toContain('8 matches')

    // 2. Cold cross-page jump to Turn 1: sidebar search stays open & selected, loadThrough pages to Turn 1,
    // focus pulse & lossless CSS.highlights apply without injecting <mark> elements into Chat message DOM.
    const turn1Marker = FIXTURE.markers.user(1)
    await sidebarSearch.fill(turn1Marker)
    await expect.poll(() => results.locator('mark').first().textContent(), { timeout: 15_000 }).toBe(turn1Marker)
    await results.click()

    expect(await sidebarSearch.inputValue()).toBe(turn1Marker)
    await expect.poll(() => results.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    const turn1Message = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: turn1Marker })
    await turn1Message.waitFor({ state: 'visible', timeout: 30_000 })

    const highlightFacts = await page.evaluate((marker) => {
      const registry = CSS.highlights
      const matchSet = registry.get('dsh-search-match')
      const activeSet = registry.get('dsh-search-active')
      const userRow = [...document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="user"]')]
        .find(el => el.textContent?.includes(marker))
      return {
        hasMatch: matchSet !== undefined && matchSet.size > 0,
        hasActive: activeSet !== undefined && activeSet.size > 0,
        domMarkCount: userRow?.querySelectorAll('mark').length ?? -1,
      }
    }, turn1Marker)
    expect(highlightFacts).toEqual({
      hasMatch: true,
      hasActive: true,
      domMarkCount: 0,
    })

    // Pressing Escape in sidebar search exits search mode and reveals the selected Session row.
    await sidebarSearch.press('Escape')
    await expect.poll(() => sidebarSearch.inputValue(), { timeout: 5_000 }).toBe('')
    await expect.poll(
      () => page.locator('[role="tree"][aria-label="Sessions"] [role="treeitem"][aria-selected="true"]').count(),
      { timeout: 10_000 },
    ).toBe(1)

    // 3. In-Session Find (Cmd+F): multi-turn matches synchronize with Turn Rail and cycle via Enter / Shift+Enter.
    await page.locator('[data-conversation-scroll]').click({ position: { x: 24, y: 24 } })
    await page.keyboard.press('Meta+f')
    const findBar = page.locator('[data-chat-search-bar]')
    await findBar.waitFor({ state: 'visible', timeout: 10_000 })
    const findInput = findBar.getByRole('searchbox', { name: 'Find in conversation', exact: true })
    await expect.poll(() => findInput.evaluate(el => el === document.activeElement)).toBe(true)

    await findInput.fill('accounted')
    const status = findBar.locator('[data-chat-search-status]')
    await expect.poll(() => status.textContent(), { timeout: 15_000 }).toBe('8 of 8')

    // Turn Rail virtualizes 64 marks and highlights visible matched turns including the active match turn.
    await expect.poll(
      () => page.locator('button[data-search-match]').count(),
      { timeout: 10_000 },
    ).toBeGreaterThanOrEqual(4)
    await expect.poll(
      () => page.locator('button[data-search-match="active"]').count(),
      { timeout: 10_000 },
    ).toBe(1)

    await findInput.press('Enter')
    await expect.poll(() => status.textContent(), { timeout: 10_000 }).toBe('1 of 8')
    await findInput.press('Shift+Enter')
    await expect.poll(() => status.textContent(), { timeout: 10_000 }).toBe('8 of 8')

    // Toggle Hybrid (token OR recall) -> Exact phrase mode.
    await findInput.fill('Both tool results are accounted for')
    await expect.poll(() => status.textContent(), { timeout: 10_000 }).toBe('80 of 80')
    const modeToggle = findBar.getByRole('button', { name: 'Hybrid', exact: true })
    await modeToggle.click()
    await expect.poll(
      () => findBar.getByRole('button', { name: 'Exact', exact: true }).getAttribute('aria-pressed'),
    ).toBe('true')
    await expect.poll(() => status.textContent(), { timeout: 10_000 }).toBe('8 of 8')

    // 4. Searching a tool-call marker inside a collapsed Turn 8 step process auto-expands the process group.
    const toolMarker = FIXTURE.markers.tool(8, 1)
    await findInput.fill(toolMarker)
    await expect.poll(() => status.textContent(), { timeout: 15_000 }).toBe('1 of 1')
    await expect.poll(
      () => page.locator('[data-chat-turn="8"]').getByText(toolMarker, { exact: false }).first().isVisible(),
      { timeout: 15_000 },
    ).toBe(true)

    // 5. Escape dismisses the Find bar and clears CSS.highlights ranges.
    await findInput.press('Escape')
    await findBar.waitFor({ state: 'detached', timeout: 5_000 })
    const cleared = await page.evaluate(() => ({
      hasMatch: CSS.highlights.has('dsh-search-match'),
      hasActive: CSS.highlights.has('dsh-search-active'),
    }))
    expect(cleared).toEqual({ hasMatch: false, hasActive: false })

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('renders semantic-match fallback badge in dark mode and fits cleanly within a 390px viewport', async () => {
    const sessionQuery = scaffold.ctx.sessionQuery
    const origSearchEvents = sessionQuery.searchEvents.bind(sessionQuery)
    sessionQuery.searchEvents = async (request, context) => {
      if (request.query === '架构语义总览' && request.mode === 'hybrid') {
        return await origSearchEvents({ ...request, query: FIXTURE.markers.user(8), mode: 'phrase' }, context)
      }
      return await origSearchEvents(request, context)
    }

    const zhPage = await browser.newPage({
      viewport: { width: 1280, height: 860 },
      locale: 'zh-CN',
    })
    await zhPage.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' })
    })
    const zhTripwire = watchConsole(zhPage)
    try {
      await zhPage.goto(scaffold.ctx.connection.authenticatedUrl(scaffold.baseUrl), { waitUntil: 'load' })
      await zhPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await zhPage.getByText('未分组', { exact: true }).waitFor({ timeout: 30_000 })

      const searchBtn = zhPage.getByRole('button', { name: '搜索会话' })
      if (await searchBtn.getAttribute('aria-expanded') !== 'true') await searchBtn.click()
      const sidebarInput = zhPage.getByRole('textbox', { name: '搜索会话标题或对话内容…', exact: true })
      await sidebarInput.fill('accounted')
      const resultRow = zhPage.getByRole('tree', { name: '搜索结果' }).getByRole('treeitem').first()
      await resultRow.waitFor({ state: 'visible', timeout: 30_000 })
      await resultRow.click()
      await zhPage.locator('[data-chat-turn]').first().waitFor({ state: 'visible', timeout: 30_000 })

      // Switch to dark mode and trigger semantic-only match fallback badge.
      await zhPage.getByRole('button', { name: '切换为深色模式' }).click()
      await zhPage.locator('[data-conversation-scroll]').click({ position: { x: 24, y: 24 } })
      await zhPage.keyboard.press('Meta+f')
      const findBar = zhPage.locator('[data-chat-search-bar]')
      await findBar.waitFor({ state: 'visible', timeout: 10_000 })
      const findInput = findBar.getByRole('searchbox')
      await findInput.fill('架构语义总览')

      const semanticBadge = zhPage.locator('[data-search-semantic-badge]').first()
      await semanticBadge.waitFor({ state: 'visible', timeout: 15_000 })
      expect(await semanticBadge.textContent()).toBe('语义相关匹配')
      expect(await semanticBadge.evaluate(el => getComputedStyle(el).justifyContent)).toBe('flex-end')

      // Narrow 390px viewport check: floating Find bar stays completely within viewport horizontally.
      await zhPage.setViewportSize({ width: 390, height: 844 })
      await findInput.fill('accounted')
      await expect.poll(() => findBar.locator('[data-chat-search-status]').textContent(), { timeout: 10_000 }).toBe('第 8 / 8 处')
      const barBox = await findBar.boundingBox()
      if (barBox === null) throw new Error('expected floating ChatSearchBar boundingBox')
      expect(barBox.x).toBeGreaterThanOrEqual(8)
      expect(barBox.x + barBox.width).toBeLessThanOrEqual(382)

      expect(zhTripwire.warnings).toEqual([])
      expect(zhTripwire.pageErrors).toEqual([])
    } finally {
      sessionQuery.searchEvents = origSearchEvents
      await zhPage.close()
    }
  }, 90_000)
})
