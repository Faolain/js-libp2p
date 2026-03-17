import { perf } from '@libp2p/perf'
import { webRTCDirect } from '@libp2p/webrtc'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'

interface BenchmarkConfig {
  target: string
  transferBytes: number
  throughputIterations: number
  latencyIterations: number
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

  document.body.textContent = JSON.stringify({ error }, null, 2)
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

    try {
      const summary = {
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        transferBytes: config.transferBytes,
        throughputIterations: config.throughputIterations,
        latencyIterations: config.latencyIterations,
        result: {
          target: target.toString(),
          upload: await runThroughput(dialer, target, config.transferBytes, 0, config.throughputIterations, config.timeoutMs),
          download: await runThroughput(dialer, target, 0, config.transferBytes, config.throughputIterations, config.timeoutMs),
          latency: await runLatency(dialer, target, config.latencyIterations, config.timeoutMs),
          remotePeer: connection.remotePeer.toString()
        }
      }

      document.body.textContent = JSON.stringify(summary, null, 2)
      await globalThis.__reportBenchmarkResult__?.(summary)
    } finally {
      await connection.close()
    }
  } finally {
    await dialer.stop()
  }
}

async function runThroughput (dialer: any, target: any, uploadBytes: number, downloadBytes: number, iterations: number, timeoutMs: number): Promise<any> {
  const samples = []

  for (let i = 0; i < iterations; i++) {
    const final = await getFinalOutput(dialer, target, uploadBytes, downloadBytes, timeoutMs)
    const bytes = uploadBytes > 0 ? final.uploadBytes : final.downloadBytes
    samples.push({
      bytes,
      timeSeconds: final.timeSeconds,
      bitrate: (bytes * 8) / final.timeSeconds
    })
  }

  const bitrates = samples.map(sample => sample.bitrate)

  return {
    unit: 'bit/s',
    median: median(bitrates),
    min: Math.min(...bitrates),
    max: Math.max(...bitrates),
    samples
  }
}

async function runLatency (dialer: any, target: any, iterations: number, timeoutMs: number): Promise<any> {
  const samples = []

  for (let i = 0; i < iterations; i++) {
    const final = await getFinalOutput(dialer, target, 1, 1, timeoutMs)
    samples.push(final.timeSeconds)
  }

  return {
    unit: 's',
    median: median(samples),
    min: Math.min(...samples),
    max: Math.max(...samples),
    samples
  }
}

async function getFinalOutput (dialer: any, target: any, uploadBytes: number, downloadBytes: number, timeoutMs: number): Promise<any> {
  let final

  for await (const output of dialer.services.perf.measurePerformance(target, uploadBytes, downloadBytes, {
    reuseExistingConnection: true,
    signal: AbortSignal.timeout(timeoutMs)
  })) {
    if (output.type === 'final') {
      final = output
    }
  }

  if (final == null) {
    throw new Error('No final perf output captured in browser benchmark')
  }

  return final
}

function median (values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }

  return sorted[middle]
}
