# Autoresearch: Improve pure WebRTC browser streaming throughput

## Objective
Improve pure WebRTC data-path throughput as much as possible without relying on relay-assisted transport behavior or benchmark-specific cheating.

The user goal is browser streaming performance, but the most reliable in-tree benchmark here is a direct WebRTC streaming benchmark (`webrtc-direct`) using fixed-size transfers over reused connections, compared against an anchored TCP baseline measured on this machine. This isolates the shared stream/datachannel path, avoids relay flakiness, removes most TCP-side ratio noise, and avoids the timeout-driven instability seen with the original `benchmark/webrtc-perf.mjs` workload on this machine. Changes should target code shared with browsers where possible, not node-only shortcuts unless they are clearly scoped and justified.

## Metrics
- **Primary**: `webrtc_direct_tcp_ratio` (unitless, higher is better)
  - Defined as the mean of:
    - `webrtc-direct upload median / anchored tcp upload baseline`
    - `webrtc-direct download median / anchored tcp download baseline`
- **Secondary**:
  - `webrtc_direct_upload_mbps`
  - `webrtc_direct_download_mbps`
  - `tcp_upload_mbps`
  - `tcp_download_mbps`
  - `webrtc_direct_latency_ms`
  - benchmark wall time

## How to Run
`./autoresearch.sh`

This rebuilds `packages/transport-webrtc`, runs `benchmark/webrtc-direct-streaming-perf.mjs`, compares the result against `benchmark/webrtc-streaming-baseline.json`, and prints `METRIC name=value` lines.

## Files in Scope
- `packages/transport-webrtc/src/stream.ts` — stream framing / send path shared by WebRTC transports
- `packages/transport-webrtc/src/constants.ts` — message sizing and buffering limits
- `packages/transport-webrtc/src/muxer.ts` — data channel stream creation
- `packages/transport-webrtc/src/private-to-public/utils/get-rtcpeerconnection.ts` — node WebRTC direct peer connection setup
- `packages/transport-webrtc/src/webrtc/index.ts` — node-only WebRTC polyfill entrypoint
- `benchmark/webrtc-perf.mjs` — original benchmark harness/context
- `benchmark/webrtc-streaming-perf.mjs` — dual-transport fixed-size benchmark used to establish the anchored TCP baseline
- `benchmark/webrtc-direct-streaming-perf.mjs` — webrtc-direct-only benchmark used in the inner optimization loop
- `benchmark/webrtc-streaming-baseline.json` — anchored TCP baseline used for the ratio metric
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
- The first fixed-size 256 MiB benchmark still showed a lot of run-to-run variance, especially from the TCP side of the ratio. Increasing transfer size to 512 MiB reduced startup noise but did not remove enough TCP variance for small improvements.
- Current inner-loop metric anchors TCP to a session-local baseline from repeated 512 MiB runs and optimizes only the WebRTC direct side against that fixed reference.
- Increasing `maxBufferedAmount` alone showed negligible gains in prior work, and raising it to 4 MiB on top of the new half-drain flow control caused transfer timeouts.
- Increasing `maxMessageSize` above 16 KiB failed with libdatachannel message-size limit errors in this environment.
- Known good wins so far:
  - node SCTP buffer tuning helped materially; the best retained setting so far is `sendBufferSize=8 MiB`, `recvBufferSize=4 MiB`
  - resuming writes when `bufferedAmount` drops below half the high-water mark improved sustained throughput over waiting for a full drain
  - sending each framed WebRTC record with a single `RTCDataChannel.send(...)` call is now a confirmed win under the anchored direct-only benchmark as well as in the earlier PR experiments
- Dead ends so far:
  - larger node SCTP buffers (`12 MiB`/`16 MiB` send, `8 MiB` recv) regressed or destabilized throughput
  - resuming writes too close to the high-water mark (`75%`) regressed badly
  - removing hot-path JS logging did not help
  - sending each framed message as one contiguous RTCDataChannel message regressed slightly in the old benchmark setup
- Prior branch work reportedly reached about `webrtc_direct_tcp_ratio ~= 0.073` on a different workload; continue re-evaluating improvements here without assuming node-only wins necessarily translate to browsers.
