import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const partitionSessions = new Map<string, {
  setProxy: ReturnType<typeof vi.fn>
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setDevicePermissionHandler: ReturnType<typeof vi.fn>
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> }
}>()

vi.mock('electron', () => ({
  app: { isPackaged: true },
  session: {
    fromPartition: vi.fn((partition: string) => {
      let existing = partitionSessions.get(partition)
      if (existing === undefined) {
        existing = {
          setProxy: vi.fn(async () => {}),
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setDevicePermissionHandler: vi.fn(),
          setDisplayMediaRequestHandler: vi.fn(),
          on: vi.fn(),
          webRequest: { onBeforeRequest: vi.fn() },
        }
        partitionSessions.set(partition, existing)
      }
      return existing
    }),
  },
}))

const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')

afterEach(() => {
  partitionSessions.clear()
  vi.restoreAllMocks()
})

describe('DesktopBrowserGuests.setProxy', () => {
  it('leaves partitions untouched while null, applies fixed_servers to existing and future partitions, and restores system mode when cleared', async () => {
    const guests = new DesktopBrowserGuests(() => 'http://127.0.0.1:3080/')
    const owner = new EventEmitter() as never

    const first = guests.acquire(owner, 'workspace-a')
    const firstSession = partitionSessions.get(first.partition)
    expect(firstSession).toBeDefined()
    expect(firstSession?.setProxy).not.toHaveBeenCalled()

    guests.setProxy(null)
    expect(firstSession?.setProxy).not.toHaveBeenCalled()

    guests.setProxy('http://127.0.0.1:52100')
    expect(firstSession?.setProxy).toHaveBeenCalledTimes(1)
    expect(firstSession?.setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http=http://127.0.0.1:52100;https=http://127.0.0.1:52100',
      proxyBypassRules: '<local>',
    })

    // Duplicate value is a no-op.
    guests.setProxy('http://127.0.0.1:52100')
    expect(firstSession?.setProxy).toHaveBeenCalledTimes(1)

    // Newly acquired partition immediately receives the active proxy.
    const second = guests.acquire(owner, 'workspace-b')
    const secondSession = partitionSessions.get(second.partition)
    expect(secondSession?.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http=http://127.0.0.1:52100;https=http://127.0.0.1:52100',
      proxyBypassRules: '<local>',
    })

    // Clearing restores Chromium system proxy resolution on both partitions.
    guests.setProxy(null)
    expect(firstSession?.setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
    expect(secondSession?.setProxy).toHaveBeenLastCalledWith({ mode: 'system' })

    // Rejected setProxy logs an error without throwing synchronously.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    firstSession?.setProxy.mockRejectedValueOnce(new Error('partition closed'))
    guests.setProxy('http://127.0.0.1:52109')
    await vi.waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith(
        'desktop browser: failed to configure partition proxy',
        expect.any(Error),
      )
    })
  })
})
