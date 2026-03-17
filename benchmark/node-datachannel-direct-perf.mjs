import { cleanup, getLibraryVersion, PeerConnection, setSctpSettings } from 'node-datachannel'

const TRANSFER_BYTES = Number(process.env.TRANSFER_BYTES ?? 512 * 1024 * 1024)
const CHUNK_BYTES = Number(process.env.CHUNK_BYTES ?? 16 * 1024)
const THROUGHPUT_ITERATIONS = Number(process.env.THROUGHPUT_ITERATIONS ?? 2)
const BUFFERED_AMOUNT_LIMIT = Number(process.env.BUFFERED_AMOUNT_LIMIT ?? 6 * 1024 * 1024)
const BUFFERED_AMOUNT_LOW = Number(process.env.BUFFERED_AMOUNT_LOW ?? Math.floor(BUFFERED_AMOUNT_LIMIT * 0.75))
const SEND_BUFFER_SIZE = Number(process.env.SEND_BUFFER_SIZE ?? 7 * 1024 * 1024)
const RECV_BUFFER_SIZE = Number(process.env.RECV_BUFFER_SIZE ?? 4 * 1024 * 1024)
const MTU = process.env.MTU != null ? Number(process.env.MTU) : 1500
const OPEN_TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT_MS ?? 20_000)
const TRANSFER_TIMEOUT_MS = Number(process.env.TRANSFER_TIMEOUT_MS ?? 120_000)

setSctpSettings({
  sendBufferSize: SEND_BUFFER_SIZE,
  recvBufferSize: RECV_BUFFER_SIZE
})

const summary = {
  timestamp: new Date().toISOString(),
  node: process.version,
  libraryVersion: getLibraryVersion(),
  transferBytes: TRANSFER_BYTES,
  chunkBytes: CHUNK_BYTES,
  throughputIterations: THROUGHPUT_ITERATIONS,
  bufferedAmountLimit: BUFFERED_AMOUNT_LIMIT,
  bufferedAmountLow: BUFFERED_AMOUNT_LOW,
  sendBufferSize: SEND_BUFFER_SIZE,
  recvBufferSize: RECV_BUFFER_SIZE,
  mtu: MTU,
  result: null
}

try {
  summary.result = {
    upload: await runThroughput('upload'),
    download: await runThroughput('download')
  }
} finally {
  cleanup()
}

console.log(JSON.stringify(summary, null, 2))

async function runThroughput (direction) {
  const samples = []
  let lastStats

  for (let i = 0; i < THROUGHPUT_ITERATIONS; i++) {
    const ctx = await createPair()

    try {
      const sender = direction === 'upload' ? ctx.dc1 : ctx.dc2
      const receiver = direction === 'upload' ? ctx.dc2 : ctx.dc1
      const sample = await runSample(sender, receiver, TRANSFER_BYTES)
      samples.push(sample)
      lastStats = {
        peer1: connectionStats(ctx.pc1),
        peer2: connectionStats(ctx.pc2)
      }
    } finally {
      ctx.dc1.close()
      ctx.dc2.close()
      ctx.pc1.close()
      ctx.pc2.close()
    }
  }

  const bitrates = samples.map(sample => sample.bitrate)

  return {
    unit: 'bit/s',
    median: median(bitrates),
    min: Math.min(...bitrates),
    max: Math.max(...bitrates),
    samples,
    lastStats
  }
}

async function createPair () {
  const config = {
    iceServers: [],
    disableFingerprintVerification: true,
    maxMessageSize: CHUNK_BYTES,
    ...(MTU > 0 ? { mtu: MTU } : {})
  }

  const pc1 = new PeerConnection('bench-1', config)
  const pc2 = new PeerConnection('bench-2', config)

  wirePeerConnections(pc1, pc2)
  wirePeerConnections(pc2, pc1)

  let dc2Resolve
  const dc2Promise = new Promise(resolve => {
    dc2Resolve = resolve
  })

  pc2.onDataChannel(dc => {
    dc2Resolve(dc)
  })

  const dc1 = pc1.createDataChannel('bench')
  const dc2 = await withTimeout(dc2Promise, OPEN_TIMEOUT_MS, 'Timed out waiting for remote data channel')

  dc1.setBufferedAmountLowThreshold(BUFFERED_AMOUNT_LOW)
  dc2.setBufferedAmountLowThreshold(BUFFERED_AMOUNT_LOW)

  await Promise.all([
    waitForOpen(dc1),
    waitForOpen(dc2)
  ])

  return { pc1, pc2, dc1, dc2 }
}

function wirePeerConnections (source, target) {
  source.onLocalDescription((sdp, type) => {
    target.setRemoteDescription(sdp, type)
  })

  source.onLocalCandidate((candidate, mid) => {
    target.addRemoteCandidate(candidate, mid)
  })
}

function waitForOpen (dc) {
  if (dc.isOpen()) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting ${OPEN_TIMEOUT_MS}ms for data channel to open`))
    }, OPEN_TIMEOUT_MS)

    dc.onOpen(() => {
      clearTimeout(timer)
      resolve()
    })

    dc.onError(err => {
      clearTimeout(timer)
      reject(new Error(`DataChannel open error: ${err}`))
    })

    dc.onClosed(() => {
      clearTimeout(timer)
      reject(new Error('DataChannel closed before opening'))
    })
  })
}

async function runSample (sender, receiver, bytesToSend) {
  const chunk = new Uint8Array(CHUNK_BYTES)
  let received = 0
  let resolveReceived
  let rejectReceived

  const receivedPromise = new Promise((resolve, reject) => {
    resolveReceived = resolve
    rejectReceived = reject
  })

  const timer = setTimeout(() => {
    rejectReceived(new Error(`Timed out waiting ${TRANSFER_TIMEOUT_MS}ms for ${bytesToSend} bytes, received ${received}`))
  }, TRANSFER_TIMEOUT_MS)

  receiver.onMessage((message) => {
    if (typeof message === 'string') {
      received += Buffer.byteLength(message)
    } else if (message instanceof ArrayBuffer) {
      received += message.byteLength
    } else {
      received += message.byteLength
    }

    if (received >= bytesToSend) {
      clearTimeout(timer)
      resolveReceived()
    }
  })

  const started = process.hrtime.bigint()
  let sent = 0

  while (sent < bytesToSend) {
    while (sender.bufferedAmount() >= BUFFERED_AMOUNT_LIMIT) {
      await waitForBufferedAmountLow(sender)
    }

    const size = Math.min(CHUNK_BYTES, bytesToSend - sent)
    const view = size === chunk.byteLength ? chunk : chunk.subarray(0, size)
    let ok = sender.sendMessageBinary(view)

    while (!ok) {
      await waitForBufferedAmountLow(sender)
      ok = sender.sendMessageBinary(view)
    }

    sent += size
  }

  await receivedPromise
  const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9

  return {
    bytes: bytesToSend,
    timeSeconds: elapsedSeconds,
    bitrate: (bytesToSend * 8) / elapsedSeconds
  }
}

function waitForBufferedAmountLow (dc) {
  if (dc.bufferedAmount() < BUFFERED_AMOUNT_LIMIT) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting ${TRANSFER_TIMEOUT_MS}ms for bufferedAmountLow; buffered=${dc.bufferedAmount()}`))
    }, TRANSFER_TIMEOUT_MS)

    dc.onBufferedAmountLow(() => {
      clearTimeout(timer)
      resolve()
    })

    dc.onClosed(() => {
      clearTimeout(timer)
      reject(new Error('DataChannel closed while waiting for bufferedAmountLow'))
    })

    dc.onError((err) => {
      clearTimeout(timer)
      reject(new Error(`DataChannel error while waiting for bufferedAmountLow: ${err}`))
    })
  })
}

function connectionStats (pc) {
  return {
    bytesSent: pc.bytesSent(),
    bytesReceived: pc.bytesReceived(),
    rtt: pc.rtt(),
    selectedCandidatePair: pc.getSelectedCandidatePair()
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

function withTimeout (promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)

    promise.then(value => {
      clearTimeout(timer)
      resolve(value)
    }, err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
