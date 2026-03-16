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
- `benchmark/webrtc-browser-client.ts` / `benchmark/webrtc-browser-direct-perf.mjs` / `benchmark/webrtc-browser-direct-perf-docker.sh` — browser-to-node direct benchmark harness for validating browser/shared-path behavior (host Playwright first, Docker fallback)
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
- Treat node-only MTU overrides as provisional until they survive the browser benchmark; local loopback can flatter packet sizes that are unsafe on real WebRTC paths where ~1200-byte payload budgeting matters for IPv6/path-MTU safety
- Maintain transport correctness; passing WebRTC tests is expected for kept results

## What's Been Tried
- Baseline from `benchmarking-results.md` on current branch: `webrtc-direct` is ~16.5x slower than TCP with 16 KiB messages and 2 MiB buffered amount.
- On this machine / Node 24, the original timeout-driven throughput harness could fail to capture `webrtc-direct` throughput samples even though direct perf transfers work. Switched autoresearch to a fixed-size, reused-connection streaming benchmark to keep experiments reliable while still measuring the pure data path.
- The first fixed-size 256 MiB benchmark still showed a lot of run-to-run variance, especially from the TCP side of the ratio. Increasing transfer size to 512 MiB reduced startup noise but did not remove enough TCP variance for small improvements.
- Current inner-loop metric anchors TCP to a session-local baseline from repeated 512 MiB runs and optimizes only the WebRTC direct side against that fixed reference.
- Even after anchoring TCP, the direct-only benchmark still shows meaningful residual noise. The workload has now been increased from 3 to 5 throughput iterations so future optimization decisions are driven more by sustained behavior and less by one-off run variance near the current frontier.
- Host-side Playwright/Chromium runs were previously blocked by missing system libraries, but the browser-to-node benchmark harness now works both directly on this host (`node benchmark/webrtc-browser-direct-perf.mjs`) and via the Docker fallback (`benchmark/webrtc-browser-direct-perf-docker.sh`).
- Quick host browser-to-node sanity checks with 64 MiB and 128 MiB transfers gave a mixed but suggestive MTU signal: forced `1500` consistently improved browser download throughput and latency versus default/unset MTU in those runs, while browser upload stayed noisy and did not show a clear winner. Treat the node-only MTU win as plausible but still provisional until more representative browser coverage exists.
- A new raw native benchmark (`benchmark/node-datachannel-direct-perf.mjs`) now isolates node-datachannel/libdatachannel throughput without libp2p framing. Early results suggest the deeper stack is indeed a major factor: default MTU is stable, lower MTUs are slower, and the `1400`-`1500` MTU region can crash/abort the raw benchmark outright even though the libp2p workload benefits from `1500` locally. Raw diagnostics also suggest the native stack is unusually sensitive to send-buffer sizing under default MTU, with several nearby values aborting outright.
- Additional native-path probes after the MTU discovery have all failed to beat the current best: unset/default MTU, `1300`, `1492`, single-sided `1500`, `enableIceTcp` on/off, `bindAddress=127.0.0.1`, `forceMediaTransport=true`, `disableAutoGathering=true`, `congestionControlModule` values `0`-`5`, and a tracked repo-side fast RTCDataChannel wrapper all improved some sub-metrics at times but still trailed the `mtu=1500` + `7 MiB/4 MiB` best.
- Increasing `maxBufferedAmount` alone showed negligible gains in prior work, and raising it to 4 MiB on top of the new half-drain flow control caused transfer timeouts. Retesting 4 MiB and probing 6.5 MiB under the current MTU-sensitive native tuning also trailed the 6 MiB best.
- Increasing `maxMessageSize` above 16 KiB failed with libdatachannel message-size limit errors in this environment. Reducing the shared chunk size below 16 KiB (e.g. `12 KiB`, `8 KiB`) also regressed materially under the current native tuning.
- Known good wins so far:
  - node SCTP buffer tuning helped materially; the best retained setting so far is `sendBufferSize=8 MiB`, `recvBufferSize=4 MiB`
  - raising `MAX_BUFFERED_AMOUNT` from the original 2 MiB to 6 MiB helped once combined with the later send/flow-control changes
  - resuming writes before full drain is important; with `MAX_BUFFERED_AMOUNT=6 MiB`, the best retained threshold so far is `75%`
  - sending each framed WebRTC record with a single `RTCDataChannel.send(...)` call is now a confirmed win under the anchored direct-only benchmark as well as in the earlier PR experiments
  - removing the per-message receive-path log from `RTCDataChannel.onmessage` improved download throughput
- Dead ends so far:
  - larger node SCTP buffers (`10 MiB`/`12 MiB`/`16 MiB` send, `5 MiB`/`8 MiB` recv) regressed or destabilized throughput
  - lower-level SCTP tuning exposed by node-datachannel/libdatachannel (`maxChunksOnQueue`, `initialCongestionWindow`, `delayedSackTime`) has so far regressed throughput or destabilized the connection
  - `MAX_BUFFERED_AMOUNT` at 1 MiB, 4 MiB, 5 MiB, 7 MiB, or 8 MiB under the current send/flow-control regime trails 6 MiB or becomes unstable
  - receive thresholds at `50%`, `66%`, `70%`, and `80%+` trail the current `75%` best
  - removing broader hot-path logging earlier did not help under older configurations, but that result was configuration-sensitive
  - manual message-only frame encoding in JS regressed despite matching the existing wire format
- Prior branch work reportedly reached about `webrtc_direct_tcp_ratio ~= 0.073` on a different workload; continue re-evaluating improvements here without assuming node-only wins necessarily translate to browsers.
ssuming node-only wins necessarily translate to browsers.
earlier did not help under older configurations, but that result was configuration-sensitive
  - manual message-only frame encoding in JS regressed despite matching the existing wire format
- Prior branch work reportedly reached about `webrtc_direct_tcp_ratio ~= 0.073` on a different workload; continue re-evaluating improvements here without assuming node-only wins necessarily translate to browsers.
ssuming node-only wins necessarily translate to browsers.
 node-only wins necessarily translate to browsers.
