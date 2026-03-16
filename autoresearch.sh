#!/usr/bin/env bash
set -euo pipefail

OUT="${TMPDIR:-/tmp}/js-libp2p-webrtc-autoresearch.json"
BASELINE="benchmark/webrtc-streaming-baseline.json"

npm --workspace packages/transport-webrtc run build >/dev/null

node benchmark/webrtc-direct-streaming-perf.mjs > "$OUT"

node --input-type=module -e "
import { readFileSync } from 'node:fs'
const summary = JSON.parse(readFileSync(process.argv[1], 'utf8'))
const baseline = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const wd = summary.result
const uploadMbps = wd.upload.median / 1e6
const downloadMbps = wd.download.median / 1e6
const ratio = ((uploadMbps / baseline.tcp_upload_mbps) + (downloadMbps / baseline.tcp_download_mbps)) / 2
const toMs = (s) => s * 1e3
console.log('METRIC webrtc_direct_tcp_ratio=' + ratio)
console.log('METRIC webrtc_direct_upload_mbps=' + uploadMbps)
console.log('METRIC webrtc_direct_download_mbps=' + downloadMbps)
console.log('METRIC tcp_upload_mbps=' + baseline.tcp_upload_mbps)
console.log('METRIC tcp_download_mbps=' + baseline.tcp_download_mbps)
console.log('METRIC webrtc_direct_latency_ms=' + toMs(wd.latency.median))
" "$OUT" "$BASELINE"
