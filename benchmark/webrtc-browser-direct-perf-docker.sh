#!/usr/bin/env bash
set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-node-js-libp2p-browser-bench}"
BROWSER_IMAGE="${BROWSER_IMAGE:-chromium-js-libp2p-browser-bench}"
BROWSER="${BROWSER:-chromium}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$repo_root"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  docker build -f interop/Dockerfile -t "$BASE_IMAGE" .
  docker build -f interop/BrowserDockerfile --build-arg=BASE_IMAGE="$BASE_IMAGE" --build-arg=BROWSER="$BROWSER" -t "$BROWSER_IMAGE" .
fi

docker run --rm \
  --entrypoint node \
  --workdir /app \
  -e TRANSFER_BYTES="${TRANSFER_BYTES:-268435456}" \
  -e THROUGHPUT_ITERATIONS="${THROUGHPUT_ITERATIONS:-2}" \
  -e LATENCY_ITERATIONS="${LATENCY_ITERATIONS:-3}" \
  -e MEASURE_TIMEOUT_MS="${MEASURE_TIMEOUT_MS:-60000}" \
  -e PAGE_TIMEOUT_MS="${PAGE_TIMEOUT_MS:-600000}" \
  "$BROWSER_IMAGE" \
  benchmark/webrtc-browser-direct-perf.mjs
