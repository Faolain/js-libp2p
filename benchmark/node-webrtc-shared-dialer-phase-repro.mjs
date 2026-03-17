import process from 'node:process'
import { perf } from '@libp2p/perf'
import { webRTCDirect } from '@libp2p/webrtc'
import { createLibp2p } from 'libp2p'

const TRANSFER_BYTES = Number(process.env.TRANSFER_BYTES ?? 96 * 1024 * 1024)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 90_000)
const PHASE_STRATEGY = process.env.PHASE_STRATEGY ?? 'shared-dialer'

const listener = await createLibp2p({
  addresses: { listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'] },
  transports: [webRTCDirect()],
  services: { perf: perf() }
})

const dialer = await createLibp2p({
  connectionGater: {
    denyDialMultiaddr: async () => false
  },
  transports: [webRTCDirect()],
  services: { perf: perf() }
})

try {
  const target = listener.getMultiaddrs().find(ma => ma.toString().includes('/webrtc-direct'))

  if (target == null) {
    throw new Error('WebRTC Direct listener did not expose a dialable multiaddr')
  }

  const connection = await dialer.dial(target, {
    signal: AbortSignal.timeout(10_000)
  })

  try {
    if (PHASE_STRATEGY === 'close-prime-before-upload') {
      await connection.close()
      await waitForNoConnections(dialer, connection.remotePeer, TIMEOUT_MS)
    }

    const upload = await getFinalOutput(dialer, target, TRANSFER_BYTES, 0, TIMEOUT_MS)

    if (PHASE_STRATEGY === 'close-prime-before-download') {
      await connection.close()
      await waitForNoConnections(dialer, connection.remotePeer, TIMEOUT_MS)
    }

    const download = await getFinalOutput(dialer, target, 0, TRANSFER_BYTES, TIMEOUT_MS)

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      transferBytes: TRANSFER_BYTES,
      timeoutMs: TIMEOUT_MS,
      phaseStrategy: PHASE_STRATEGY,
      remotePeer: connection.remotePeer.toString(),
      upload,
      download
    }, null, 2))
  } finally {
    await connection.close()
  }
} finally {
  await dialer.stop()
  await listener.stop()
}

async function getFinalOutput (dialer, target, uploadBytes, downloadBytes, timeoutMs) {
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
  } catch (err) {
    throw new Error(`${err?.message ?? String(err)} :: recentOutputs=${JSON.stringify(recentOutputs)}`)
  }

  if (final == null) {
    throw new Error(`No final perf output captured :: recentOutputs=${JSON.stringify(recentOutputs)}`)
  }

  return final
}

async function waitForNoConnections (dialer, peer, timeoutMs) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (dialer.getConnections(peer).length === 0) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 25))
  }

  throw new Error(`Timed out waiting for dialer connections to close :: remainingConnections=${dialer.getConnections(peer).length}`)
}
