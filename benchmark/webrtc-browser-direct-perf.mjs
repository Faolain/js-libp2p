import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { perf } from '@libp2p/perf'
import { webRTCDirect } from '@libp2p/webrtc'
import { chromium } from 'playwright-core'
import { createLibp2p } from 'libp2p'

const TRANSFER_BYTES = Number(process.env.TRANSFER_BYTES ?? 256 * 1024 * 1024)
const THROUGHPUT_ITERATIONS = Number(process.env.THROUGHPUT_ITERATIONS ?? 2)
const LATENCY_ITERATIONS = Number(process.env.LATENCY_ITERATIONS ?? 3)
const MEASURE_TIMEOUT_MS = Number(process.env.MEASURE_TIMEOUT_MS ?? 60_000)
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS ?? 600_000)

const listener = await createLibp2p({
  addresses: { listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'] },
  transports: [webRTCDirect()],
  services: { perf: perf() }
})

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webrtc-browser-bench-'))
let server
let browser

try {
  const target = listener.getMultiaddrs().find(ma => ma.toString().includes('/webrtc-direct'))

  if (target == null) {
    throw new Error('WebRTC Direct listener did not expose a dialable multiaddr')
  }

  const clientBundlePath = path.join(tempDir, 'client.js')
  await build({
    entryPoints: [path.resolve('benchmark/webrtc-browser-client.ts')],
    outfile: clientBundlePath,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    define: {
      'process.env.NODE_ENV': '"production"'
    },
    sourcemap: 'inline'
  })

  const clientBundle = await fs.readFile(clientBundlePath)
  const serverInfo = await startStaticServer(clientBundle)
  server = serverInfo.server

  const result = await new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting ${PAGE_TIMEOUT_MS}ms for browser benchmark result`))
    }, PAGE_TIMEOUT_MS)

    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage'
        ]
      })

      const page = await browser.newPage()
      page.on('console', msg => {
        console.error(`[browser:${msg.type()}] ${msg.text()}`)
      })
      page.on('pageerror', err => {
        console.error(`[browser:pageerror] ${err.stack ?? err.message}`)
      })

      await page.exposeFunction('__reportBenchmarkResult__', async payload => {
        clearTimeout(timeout)
        resolve(payload)
      })

      await page.exposeFunction('__reportBenchmarkError__', async payload => {
        clearTimeout(timeout)
        reject(new Error(`Browser benchmark failed: ${payload?.stack ?? payload?.message ?? String(payload)}`))
      })

      await page.addInitScript((config) => {
        globalThis.__WEBRTC_BROWSER_BENCHMARK_CONFIG__ = config
      }, {
        target: target.toString(),
        transferBytes: TRANSFER_BYTES,
        throughputIterations: THROUGHPUT_ITERATIONS,
        latencyIterations: LATENCY_ITERATIONS,
        timeoutMs: MEASURE_TIMEOUT_MS
      })

      await page.goto(serverInfo.url, {
        waitUntil: 'load',
        timeout: 30_000
      })
    } catch (err) {
      clearTimeout(timeout)
      reject(err)
    }
  })

  const summary = {
    timestamp: new Date().toISOString(),
    node: process.version,
    transferBytes: TRANSFER_BYTES,
    throughputIterations: THROUGHPUT_ITERATIONS,
    latencyIterations: LATENCY_ITERATIONS,
    measureTimeoutMs: MEASURE_TIMEOUT_MS,
    result
  }

  console.log(JSON.stringify(summary, null, 2))
} finally {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
  await fs.rm(tempDir, { recursive: true, force: true })
  await listener.stop()
}

async function startStaticServer (clientBundle) {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>WebRTC browser benchmark</title>
  </head>
  <body>
    <pre id="output">starting browser benchmark...</pre>
    <script src="/client.js"></script>
  </body>
</html>`

  const server = createServer((req, res) => {
    if (req.url === '/client.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end(clientBundle)
      return
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()

  if (address == null || typeof address === 'string') {
    throw new Error('Failed to determine benchmark server address')
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`
  }
}
