#!/usr/bin/env bash
set -euo pipefail

OUT="${TMPDIR:-/tmp}/js-libp2p-webrtc-autoresearch.json"

npm --workspace packages/transport-webrtc run build >/dev/null

node benchmark/webrtc-streaming-perf.mjs > "$OUT"

node --input-type=module -e "
import { readFileSync } from 'node:fs'
const summary = JSON.parse(readFileSync(process.argv[1], 'utf8'))
const tcp = summary.results.tcp
const wd = summary.results['webrtc-direct']
const ratio = ((wd.upload.median / tcp.upload.median) + (wd.download.median / tcp.download.median)) / 2
const toMbps = (bits) => bits / 1e6
const toMs = (s) => s * 1e3
console.log('METRIC webrtc_direct_tcp_ratio=' + ratio)
console.log('METRIC webrtc_direct_upload_mbps=' + toMbps(wd.upload.median))
console.log('METRIC webrtc_direct_download_mbps=' + toMbps(wd.download.median))
console.log('METRIC tcp_upload_mbps=' + toMbps(tcp.upload.median))
console.log('METRIC tcp_download_mbps=' + toMbps(tcp.download.median))
console.log('METRIC webrtc_direct_latency_ms=' + toMs(wd.latency.median))
" "$OUT"
