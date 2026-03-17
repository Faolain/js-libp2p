import { perf } from '@libp2p/perf'
import { webRTCDirect } from '@libp2p/webrtc'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'

interface BenchmarkConfig {
  target: string
  transferBytes: number
  timeoutMs: number
}

declare global {
  var __WEBRTC_BROWSER_BENCHMARK_CONFIG__: BenchmarkConfig | undefined
  var __reportBenchmarkResult__: ((result: unknown) => Promise<void>) | undefined
  var __reportBenchmarkError__: ((error: { message: string, stack?: string }) => Promise<void>) | undefined
}

void main().catch(async (err: any) => {
  const error = {
    message: err?.message ?? String(err),
    stack: err?.stack
  }

  await globalThis.__reportBenchmarkError__?.(error)
  throw err
})

async function main (): Promise<void> {
  const config = globalThis.__WEBRTC_BROWSER_BENCHMARK_CONFIG__

  if (config == null) {
    throw new Error('Missing __WEBRTC_BROWSER_BENCHMARK_CONFIG__')
  }

  const target = multiaddr(config.target)
  const dialer = await createLibp2p({
    connectionGater: {
      denyDialMultiaddr: async () => false
    },
    transports: [webRTCDirect()],
    services: { perf: perf() }
  })

  try {
    const connection = await dialer.dial(target, {
      signal: AbortSignal.timeout(10_000)
    })

    const remotePeer = connection.remotePeer
    const upload = await getFinalOutput(dialer, target, config.transferBytes, 0, config.timeoutMs)

    await dialer.hangUp(remotePeer, {
      signal: AbortSignal.timeout(config.timeoutMs)
    })

    await waitForNoConnections(dialer, remotePeer, config.timeoutMs)

    const download = await getFinalOutput(dialer, target, 0, config.transferBytes, config.timeoutMs)

    await globalThis.__reportBenchmarkResult__?.({
      target: target.toString(),
      remotePeer: remotePeer.toString(),
      upload,
      download,
      remainingConnections: dialer.getConnections(remotePeer).length
    })
  } finally {
    await dialer.stop()
  }
}

async function getFinalOutput (dialer: any, target: any, uploadBytes: number, downloadBytes: number, timeoutMs: number): Promise<any> {
  let final
  const recentOutputs = []

  try {
    for await (const output of dialer.services.perf.measurePerformance(target, uploadBytes, downloadBytes, {
      reuseExistingConnection: true,
      signal: AbortSignal.timeout(timeoutMs)
    })) {
      recentOutputs.push(output)

      if (recentOutputs.length > 5) {
        recentOutputs.shift()
      }

      if (output.type === 'final') {
        final = output
      }
    }
  } catch (err: any) {
    throw new Error(`${err?.message ?? String(err)} :: recentOutputs=${JSON.stringify(recentOutputs)}`)
  }

  if (final == null) {
    throw new Error(`No final perf output captured :: recentOutputs=${JSON.stringify(recentOutputs)}`)
  }

  return final
}

async function waitForNoConnections (dialer: any, peer: any, timeoutMs: number): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (dialer.getConnections(peer).length === 0) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 25))
  }

  throw new Error(`Timed out waiting for zero connections :: remainingConnections=${dialer.getConnections(peer).length}`)
}
