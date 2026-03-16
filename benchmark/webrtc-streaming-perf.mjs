import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { perf } from '@libp2p/perf'
import { tcp } from '@libp2p/tcp'
import { webRTCDirect } from '@libp2p/webrtc'
import { createLibp2p } from 'libp2p'

const TRANSFER_BYTES = 256 * 1024 * 1024
const THROUGHPUT_ITERATIONS = 2
const LATENCY_ITERATIONS = 5

const summary = {
  timestamp: new Date().toISOString(),
  node: process.version,
  transferBytes: TRANSFER_BYTES,
  throughputIterations: THROUGHPUT_ITERATIONS,
  latencyIterations: LATENCY_ITERATIONS,
  results: {}
}

for (const transport of ['tcp', 'webrtc-direct']) {
  const context = await createContext(transport)

  try {
    const connection = await context.dialer.dial(context.target, {
      signal: AbortSignal.timeout(10_000)
    })

    summary.results[transport] = {
      target: context.target.toString(),
      upload: await runThroughput(context.dialer, context.target, TRANSFER_BYTES, 0),
      download: await runThroughput(context.dialer, context.target, 0, TRANSFER_BYTES),
      latency: await runLatency(context.dialer, context.target),
      remotePeer: connection.remotePeer.toString()
    }

    await connection.close()
  } finally {
    await context.stop()
  }
}

console.log(JSON.stringify(summary, null, 2))

async function runThroughput (dialer, target, uploadBytes, downloadBytes) {
  const samples = []

  for (let i = 0; i < THROUGHPUT_ITERATIONS; i++) {
    const final = await getFinalOutput(dialer, target, uploadBytes, downloadBytes)
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

async function runLatency (dialer, target) {
  const samples = []

  for (let i = 0; i < LATENCY_ITERATIONS; i++) {
    const final = await getFinalOutput(dialer, target, 1, 1)
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

async function getFinalOutput (dialer, target, uploadBytes, downloadBytes) {
  let final

  for await (const output of dialer.services.perf.measurePerformance(target, uploadBytes, downloadBytes, {
    reuseExistingConnection: true,
    signal: AbortSignal.timeout(60_000)
  })) {
    if (output.type === 'final') {
      final = output
    }
  }

  if (final == null) {
    throw new Error('No final perf output captured')
  }

  return final
}

async function createContext (transport) {
  if (transport === 'tcp') {
    const listener = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { perf: perf() }
    })

    const dialer = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { perf: perf() }
    })

    return {
      target: listener.getMultiaddrs()[0],
      dialer,
      stop: async () => {
        await dialer.stop()
        await listener.stop()
      }
    }
  }

  const listener = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'] },
    transports: [webRTCDirect()],
    services: { perf: perf() }
  })

  const dialer = await createLibp2p({
    transports: [webRTCDirect()],
    services: { perf: perf() }
  })

  const target = listener.getMultiaddrs().find(ma => ma.toString().includes('/webrtc-direct'))

  if (target == null) {
    throw new Error('WebRTC Direct listener did not expose a dialable multiaddr')
  }

  return {
    target,
    dialer,
    stop: async () => {
      await dialer.stop()
      await listener.stop()
    }
  }
}

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }

  return sorted[middle]
}
