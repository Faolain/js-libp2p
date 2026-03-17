// Minimal node-datachannel/polyfill repro for the newer libdatachannel 0.24.x
// aggressive repeated-send regression. Uses a negotiated handshake channel plus
// one application data channel and floods repeated sends with env-configurable
// knobs (ICE TCP, server UDP mux, MTU, SCTP buffers, bufferedAmount limits).
import { access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const MODULE_CANDIDATES = [
  '/home/takopi/js-libp2p/node_modules/node-datachannel/dist/esm',
  '/home/takopi/js-libp2p/packages/transport-webrtc/node_modules/node-datachannel/dist/esm'
]

let moduleBase
for (const candidate of MODULE_CANDIDATES) {
  try {
    await access(candidate)
    moduleBase = candidate
    break
  } catch {}
}

if (moduleBase == null) {
  throw new Error(`Could not resolve node-datachannel dist/esm from ${MODULE_CANDIDATES.join(', ')}`)
}

const lib = await import(pathToFileURL(`${moduleBase}/lib/index.mjs`).href)
const polyfill = await import(pathToFileURL(`${moduleBase}/polyfill/index.mjs`).href)

const { cleanup, getLibraryVersion, setSctpSettings } = lib
const { RTCPeerConnection } = polyfill

const TRANSFER_BYTES = Number(process.env.TRANSFER_BYTES ?? 64 * 1024 * 1024)
const CHUNK_BYTES = Number(process.env.CHUNK_BYTES ?? 16 * 1024)
const BUFFERED_AMOUNT_LIMIT = Number(process.env.BUFFERED_AMOUNT_LIMIT ?? 6 * 1024 * 1024)
const BUFFERED_AMOUNT_LOW = Number(process.env.BUFFERED_AMOUNT_LOW ?? Math.floor(BUFFERED_AMOUNT_LIMIT * 0.82))
const OPEN_TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT_MS ?? 15_000)
const SEND_BUFFER_SIZE = Number(process.env.SEND_BUFFER_SIZE ?? 6 * 1024 * 1024)
const RECV_BUFFER_SIZE = Number(process.env.RECV_BUFFER_SIZE ?? 4 * 1024 * 1024)
const CONGESTION_CONTROL_MODULE = process.env.CONGESTION_CONTROL_MODULE != null ? Number(process.env.CONGESTION_CONTROL_MODULE) : 1
const ENABLE_ICE_TCP = process.env.ENABLE_ICE_TCP !== 'false'
const ENABLE_SERVER_UDP_MUX = process.env.ENABLE_SERVER_UDP_MUX !== 'false'
const MTU = process.env.MTU != null ? Number(process.env.MTU) : 1500

const started = process.hrtime.bigint()
const timeline = []

function nowMs () {
  return Number(process.hrtime.bigint() - started) / 1e6
}

function log (event, data = {}) {
  const entry = { tMs: Number(nowMs().toFixed(3)), event, ...data }
  timeline.push(entry)
  console.error(JSON.stringify(entry))
}

function pairOf (pc) {
  try {
    return pc.selectedCandidatePair?.() ?? null
  } catch {
    return null
  }
}

function attachPc (name, pc) {
  pc.addEventListener('connectionstatechange', () => log(`${name}.connectionstatechange`, { state: pc.connectionState, ice: pc.iceConnectionState, pair: pairOf(pc) }))
  pc.addEventListener('iceconnectionstatechange', () => log(`${name}.iceconnectionstatechange`, { state: pc.iceConnectionState, connection: pc.connectionState, pair: pairOf(pc) }))
  pc.addEventListener('datachannel', (evt) => log(`${name}.datachannel`, { id: evt.channel.id, label: evt.channel.label, readyState: evt.channel.readyState }))
}

function attachDc (name, dc, onBytes) {
  dc.addEventListener('open', () => log(`${name}.open`, { buffered: dc.bufferedAmount }))
  dc.addEventListener('close', () => log(`${name}.close`, { buffered: dc.bufferedAmount }))
  dc.addEventListener('error', (evt) => log(`${name}.error`, { error: evt.error?.message ?? String(evt.error), buffered: dc.bufferedAmount }))
  dc.addEventListener('bufferedamountlow', () => log(`${name}.bufferedamountlow`, { buffered: dc.bufferedAmount }))
  dc.addEventListener('message', (evt) => {
    const size = typeof evt.data === 'string' ? Buffer.byteLength(evt.data) : evt.data.byteLength
    onBytes?.(size)
  })
}

function withTimeout (promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(v => {
      clearTimeout(timer)
      resolve(v)
    }, err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function waitForOpen (name, dc) {
  if (dc.readyState === 'open') {
    log(`${name}.alreadyOpen`, { buffered: dc.bufferedAmount })
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out waiting for open`)), OPEN_TIMEOUT_MS)
    dc.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    dc.addEventListener('close', () => {
      clearTimeout(timer)
      reject(new Error(`${name} closed before open`))
    }, { once: true })
    dc.addEventListener('error', (evt) => {
      clearTimeout(timer)
      reject(new Error(`${name} error before open: ${evt.error?.message ?? evt.error}`))
    }, { once: true })
  })
}

function waitForBufferedLow (name, dc) {
  if (dc.bufferedAmount < BUFFERED_AMOUNT_LIMIT) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out waiting for bufferedamountlow with buffered=${dc.bufferedAmount}`)), OPEN_TIMEOUT_MS)
    dc.addEventListener('bufferedamountlow', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    dc.addEventListener('close', () => {
      clearTimeout(timer)
      reject(new Error(`${name} closed while waiting for bufferedamountlow`))
    }, { once: true })
    dc.addEventListener('error', (evt) => {
      clearTimeout(timer)
      reject(new Error(`${name} error while waiting for bufferedamountlow: ${evt.error?.message ?? evt.error}`))
    }, { once: true })
  })
}

try {
  setSctpSettings({
    sendBufferSize: SEND_BUFFER_SIZE,
    recvBufferSize: RECV_BUFFER_SIZE,
    congestionControlModule: CONGESTION_CONTROL_MODULE
  })

  log('session.start', {
    libraryVersion: getLibraryVersion(),
    transferBytes: TRANSFER_BYTES,
    chunkBytes: CHUNK_BYTES,
    bufferedAmountLimit: BUFFERED_AMOUNT_LIMIT,
    bufferedAmountLow: BUFFERED_AMOUNT_LOW,
    sendBufferSize: SEND_BUFFER_SIZE,
    recvBufferSize: RECV_BUFFER_SIZE,
    congestionControlModule: CONGESTION_CONTROL_MODULE,
    enableIceTcp: ENABLE_ICE_TCP,
    enableServerIceUdpMux: ENABLE_SERVER_UDP_MUX,
    mtu: MTU
  })

  const commonConfig = {
    iceServers: [],
    disableFingerprintVerification: true,
    enableIceTcp: ENABLE_ICE_TCP,
    ...(MTU > 0 ? { mtu: MTU } : {})
  }

  const pc1 = new RTCPeerConnection({
    ...commonConfig,
    enableIceUdpMux: false,
    peerIdentity: 'repro-client'
  })
  const pc2 = new RTCPeerConnection({
    ...commonConfig,
    enableIceUdpMux: ENABLE_SERVER_UDP_MUX,
    peerIdentity: 'repro-server'
  })

  attachPc('pc1', pc1)
  attachPc('pc2', pc2)

  pc1.addEventListener('icecandidate', (evt) => {
    if (evt.candidate != null) {
      void pc2.addIceCandidate(evt.candidate)
    }
  })
  pc2.addEventListener('icecandidate', (evt) => {
    if (evt.candidate != null) {
      void pc1.addIceCandidate(evt.candidate)
    }
  })

  const hs1 = pc1.createDataChannel('', { negotiated: true, id: 0 })
  const hs2 = pc2.createDataChannel('', { negotiated: true, id: 0 })
  attachDc('hs1', hs1)
  attachDc('hs2', hs2)

  const offer = await pc1.createOffer()
  await pc1.setLocalDescription(offer)
  await pc2.setRemoteDescription(pc1.localDescription)
  const answer = await pc2.createAnswer()
  await pc2.setLocalDescription(answer)
  await pc1.setRemoteDescription(pc2.localDescription)

  await Promise.all([
    waitForOpen('hs1', hs1),
    waitForOpen('hs2', hs2)
  ])
  log('handshake.opened', { pair1: pairOf(pc1), pair2: pairOf(pc2) })

  let app2Resolve
  const app2Promise = new Promise((resolve) => {
    app2Resolve = resolve
  })
  pc2.addEventListener('datachannel', (evt) => {
    app2Resolve(evt.channel)
  }, { once: true })

  let receivedBytes = 0
  const app1 = pc1.createDataChannel('')
  app1.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW
  attachDc('app1', app1)
  const app2 = await withTimeout(app2Promise, OPEN_TIMEOUT_MS, 'Timed out waiting for app2 datachannel')
  app2.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW
  attachDc('app2', app2, (size) => {
    receivedBytes += size
  })

  await Promise.all([
    waitForOpen('app1', app1),
    waitForOpen('app2', app2)
  ])
  log('app.opened', { pair1: pairOf(pc1), pair2: pairOf(pc2) })

  const chunk = new Uint8Array(CHUNK_BYTES)
  let sentBytes = 0
  while (sentBytes < TRANSFER_BYTES) {
    while (app1.bufferedAmount >= BUFFERED_AMOUNT_LIMIT) {
      await waitForBufferedLow('app1', app1)
    }

    const size = Math.min(CHUNK_BYTES, TRANSFER_BYTES - sentBytes)
    const view = size === chunk.byteLength ? chunk : chunk.subarray(0, size)
    app1.send(view)
    sentBytes += size

    if (sentBytes % (8 * 1024 * 1024) === 0) {
      log('transfer.progress', { sentBytes, receivedBytes, app1Buffered: app1.bufferedAmount, pair1: pairOf(pc1), pair2: pairOf(pc2) })
    }
  }

  await withTimeout(new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (receivedBytes >= TRANSFER_BYTES) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
    app2.addEventListener('close', () => {
      clearInterval(timer)
      reject(new Error(`app2 closed after ${receivedBytes}/${TRANSFER_BYTES} bytes`))
    }, { once: true })
  }), OPEN_TIMEOUT_MS, `Timed out waiting for ${TRANSFER_BYTES} bytes, got ${receivedBytes}`)

  log('transfer.complete', { sentBytes, receivedBytes, pair1: pairOf(pc1), pair2: pairOf(pc2) })

  console.log(JSON.stringify({
    libraryVersion: getLibraryVersion(),
    outcome: 'ok',
    pc1State: pc1.connectionState,
    pc2State: pc2.connectionState,
    receivedBytes,
    pair1: pairOf(pc1),
    pair2: pairOf(pc2),
    timeline
  }, null, 2))

  pc1.close()
  pc2.close()
  cleanup()
} catch (err) {
  console.log(JSON.stringify({
    libraryVersion: getLibraryVersion(),
    outcome: 'failed',
    error: err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) },
    timeline
  }, null, 2))
  cleanup()
  process.exitCode = 1
}
