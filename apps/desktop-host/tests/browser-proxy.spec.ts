import { Context, Service } from '@deepseek-ai/cordis'
import type NetworkProxyService from '@deepseek-ai/dsh-network-proxy'
import { expect, it } from 'vitest'
import { installBrowserProxyPublisher } from '../src/browser-proxy.ts'

class MockNetworkProxy extends Service implements Pick<NetworkProxyService, 'browserGuestProxyUrl'> {
  currentUrl: string | null = null

  constructor(ctx: Context, initialUrl: string | null = null) {
    super(ctx, 'networkProxy')
    this.currentUrl = initialUrl
  }

  browserGuestProxyUrl(): string | null {
    return this.currentUrl
  }
}

it('publishes initial and updated loopback proxy URLs, deduplicates repeats, and clears on disposal', async () => {
  const ctx = new Context()
  const published: (string | null)[] = []
  installBrowserProxyPublisher(ctx, (url) => {
    published.push(url)
  })

  try {
    let instance: MockNetworkProxy | undefined
    const first = await ctx.plugin((scope) => {
      instance = new MockNetworkProxy(scope, 'http://127.0.0.1:41001')
    })
    expect(published).toEqual(['http://127.0.0.1:41001'])

    ctx.emit('network-proxy/changed')
    expect(published).toEqual(['http://127.0.0.1:41001'])

    if (instance === undefined) throw new Error('missing MockNetworkProxy instance')
    instance.currentUrl = 'http://127.0.0.1:41002'
    ctx.emit('network-proxy/changed')
    expect(published).toEqual(['http://127.0.0.1:41001', 'http://127.0.0.1:41002'])

    await first.dispose()
    expect(published).toEqual(['http://127.0.0.1:41001', 'http://127.0.0.1:41002', null])

    const second = await ctx.plugin(MockNetworkProxy, null)
    expect(published).toEqual(['http://127.0.0.1:41001', 'http://127.0.0.1:41002', null, null])

    await second.dispose()
    expect(published).toEqual(['http://127.0.0.1:41001', 'http://127.0.0.1:41002', null, null])
  } finally {
    await ctx.fiber.dispose()
  }
})
