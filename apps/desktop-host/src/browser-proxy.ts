/** Keeps Electron's Sidebar `<webview>` guest partitions bound to the active loopback proxy gateway. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-network-proxy'

/**
 * Publish loopback HTTP proxy URLs (`http://127.0.0.1:<port>`) for each `networkProxy` provider lifetime,
 * clearing them (`null`) when disabled or disposed.
 * @param ctx - Host context owning the optional `networkProxy` dependency subscription.
 * @param publish - Synchronous private IPC delivery to the Electron main process.
 */
export function installBrowserProxyPublisher(ctx: Context, publish: (proxyUrl: string | null) => void): void {
  ctx.inject(['networkProxy'], (proxyCtx) => {
    const networkProxy = proxyCtx.networkProxy
    proxyCtx.effect(() => {
      let lastPublished: string | null | undefined
      const sync = (): void => {
        const next = networkProxy.browserGuestProxyUrl()
        if (next !== lastPublished) {
          lastPublished = next
          publish(next)
        }
      }
      sync()
      const offChanged = proxyCtx.on('network-proxy/changed', () => {
        sync()
      })
      return () => {
        offChanged()
        if (lastPublished !== null) {
          lastPublished = null
          publish(null)
        }
      }
    })
  })
}
