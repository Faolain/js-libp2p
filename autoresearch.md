# Autoresearch: Improve pure WebRTC browser streaming throughput

## Objective
Improve pure WebRTC data-path throughput as much as possible without relying on relay-assisted transport behavior or benchmark-specific cheating.

The user goal is browser streaming performance, but the most reliable in-tree benchmark here is the direct WebRTC transport benchmark (`webrtc-direct`) against the TCP baseline. This isolates the shared stream/datachannel path and avoids relay flakiness. Changes should target code shared with browsers where possible, not node-only shortcuts unless they are clearly scoped and justified.

## Metrics
- **Primary**: `webrtc_direct_tcp_ratio` (unitless, higher is better)
  - Defined as the mean of:
    - `webrtc-direct upload median / tcp upload median`
    - `webrtc-direct download median / tcp download median`
- **Secondary**:
  - `webrtc_direct_upload_mbps`
  - `webrtc_direct_download_mbps`
  - `tcp_upload_mbps`
  - `tcp_download_mbps`
  - `webrtc_direct_latency_ms`
  - benchmark wall time

## How to Run
`./autoresearch.sh`

This runs `benchmark/webrtc-perf.mjs` for `tcp` and `webrtc-direct`, parses the JSON, and prints `METRIC name=value` lines.

## Files in Scope
- `packages/transport-webrtc/src/stream.ts` — stream framing / send path shared by WebRTC transports
- `packages/transport-webrtc/src/constants.ts` — message sizing and buffering limits
- `packages/transport-webrtc/src/muxer.ts` — data channel stream creation
- `packages/transport-webrtc/src/private-to-public/utils/get-rtcpeerconnection.ts` — node WebRTC direct peer connection setup
- `packages/transport-webrtc/src/webrtc/index.ts` — node-only WebRTC polyfill entrypoint
- `benchmark/webrtc-perf.mjs` — original benchmark harness/context
- `benchmark/webrtc-streaming-perf.mjs` — fixed-size direct streaming benchmark used for autoresearch
- `autoresearch.sh` / `autoresearch.checks.sh` / `autoresearch.md`

## Off Limits
- No benchmark result fabrication
- No changing benchmark semantics to make the metric look better without real throughput gains
- No relay-dependent optimizations that hide pure WebRTC performance
- No changes outside WebRTC / benchmark support files unless clearly required

## Constraints
- Avoid overfitting to relay behavior; prefer `webrtc-direct`
- Prefer changes that help shared browser/node code paths
- Keep the benchmark workload representative
- Maintain transport correctness; passing WebRTC tests is expected for kept results

## What's Been Tried
- Baseline from `benchmarking-results.md` on current branch: `webrtc-direct` is ~16.5x slower than TCP with 16 KiB messages and 2 MiB buffered amount.
- On this machine / Node 24, the original timeout-driven throughput harness could fail to capture `webrtc-direct` throughput samples even though direct perf transfers work. Switched autoresearch to a fixed-size, reused-connection streaming benchmark to keep experiments reliable while still measuring the pure data path.
- Increasing `maxBufferedAmount` alone showed negligible gains.
- Increasing `maxMessageSize` above 16 KiB failed with libdatachannel message-size limit errors in this environment.
- Prior branch work reportedly reached about `webrtc_direct_tcp_ratio ~= 0.073` via node-side tuning. Re-evaluate and continue from there, but avoid assuming node-only wins necessarily translate to browsers.
- Likely fruitful areas: shared send/framing overhead, avoiding extra copies/fragmentation costs, and node SCTP tuning where it gives real pure-WebRTC wins.
a copies/fragmentation costs, and node SCTP tuning where it gives real pure-WebRTC wins.
