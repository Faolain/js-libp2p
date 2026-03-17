# WebRTC autoresearch summary (2026-03-17)

This branch preserves the full WebRTC autoresearch session, including benchmark harnesses, repros, experiment logs, and conclusions.

## Scope

Primary optimization target during the loop:

- `webrtc_direct_tcp_ratio` (higher is better)
- measured via `./autoresearch.sh`
- anchored against `benchmark/webrtc-streaming-baseline.json`

Important constraint discovered during the work:

- the **browser build does not use `node-datachannel`**
- `@libp2p/webrtc` swaps `src/webrtc/index.ts` for `src/webrtc/index.browser.ts` in browsers
- therefore:
  - changes in `packages/transport-webrtc/src/stream.ts` are the most browser-relevant transport-path changes
  - changes in `packages/transport-webrtc/src/webrtc/index.ts` and `packages/transport-webrtc/src/private-to-public/utils/get-rtcpeerconnection.ts` are **Node-only**

## Best kept result in the main loop

Current kept best commit on this branch:

- `a52027b` — `webrtc_direct_tcp_ratio=0.3515425237265303`

Configuration at that point:

- `node-datachannel@0.32.1`
- `libdatachannel 0.24.0`
- `enableIceTcp=false`
- `enableIceUdpMux=false`
- `mtu=1500`
- `sendBufferSize=3 MiB`
- `recvBufferSize=2 MiB`
- `MAX_BUFFERED_AMOUNT=2 MiB`
- `bufferedAmountLowThreshold=70%`
- `congestionControlModule=1`

This is a strong **Node-side benchmark win**, but it should not be described as a pure browser win because key parts of that configuration are specific to the Node `node-datachannel` path.

## Browser/shared-path wins worth keeping in mind

The most credible browser-relevant changes are in `packages/transport-webrtc/src/stream.ts`:

- send each framed libp2p record with a **single** `RTCDataChannel.send(...)`
- remove per-message receive-path logging
- add a fast path for the common case where one data-channel message contains one complete framed libp2p record
- keep `onmessage` synchronous
- resume writes before full drain, with the current best shared-path threshold around `70%` under the latest no-mux queue shape

These are the best candidates for a later browser/shared-path PR.

## Node-only findings

The biggest benchmark gains came from Node-side tuning:

- moving from `node-datachannel 0.29.0` to `0.32.1` only became competitive once the queue shape changed substantially
- disabling **server-side ICE UDP mux** was the biggest stability/performance breakthrough on the 0.24.x line
- explicit `mtu=1500` was a major local win in the Node benchmark
- smaller queue shape (`3 MiB` send / `2 MiB` recv / `2 MiB` buffered cap) plus `70%` pacing beat the older larger-buffer regime under the current 5-iteration benchmark

These are good candidates for a later Node-focused PR or for upstream `node-datachannel`/`libdatachannel` investigation, but they should not be presented as browser-path improvements.

## Browser benchmark conclusions

Browser checks improved meaningfully compared to earlier configurations, but the loop did **not** show that browser WebRTC beats TCP.

Key browser observations:

- the current best config can pass `32 MiB` browser checks reliably enough to be useful
- `64 MiB`, `72 MiB`, `73 MiB`, and even `84 MiB` browser runs sometimes pass, but that region is noisy
- `96 MiB` and `128 MiB` remain unstable in the full shared-session browser workflow
- upload-only `96 MiB` browser runs can pass
- download-only `96 MiB` browser runs can pass
- the failure is therefore not simply one-way throughput

## Most important unresolved browser issue

The strongest current browser diagnosis is a **shared-dialer teardown / `hangUp()` close-sequencing problem**, not just raw throughput.

Evidence gathered in this branch:

- full browser `96 MiB` upload+download can pass when using a **fresh dialer per phase**
- it can also pass on a **shared dialer** if the priming connection is closed directly and the harness waits for zero live connections before starting download
- the bad path is strongly associated with `hangUp()` / connection-manager teardown on the shared browser dialer
- a temporary simplification of `connectionManager.closeConnections()` to just `await connection.close()` made the bad workflow pass
- a narrower temporary change that sequenced close as:
  - `const closeEvent = pEvent(connection, 'close')`
  - `await connection.close()`
  - `await closeEvent`
  also made the bad workflow pass
- the current implementation in `packages/libp2p/src/connection-manager/index.ts` does:
  - `await Promise.all([pEvent(connection, 'close', options), connection.close(options)])`

That parallel close sequencing is now the leading suspect for the browser shared-dialer failure mode.

## Useful repro / diagnostic assets preserved on this branch

- `benchmark/webrtc-browser-direct-perf.mjs`
- `benchmark/webrtc-browser-client.ts`
- `benchmark/node-datachannel-direct-perf.mjs`
- `benchmark/node-datachannel-polyfill-repeated-send-repro.mjs`
- `benchmark/node-datachannel-polyfill-stream-repro.mjs`
- `benchmark/node-webrtc-shared-dialer-phase-repro.mjs`
- `autoresearch.jsonl`
- `autoresearch.md`
- `autoresearch.ideas.md`

## Recommended next split after preserving this branch

1. **Browser/shared-path PR**
   - focus on `packages/transport-webrtc/src/stream.ts`
2. **Node-only PR**
   - focus on `packages/transport-webrtc/src/webrtc/index.ts`
   - and `packages/transport-webrtc/src/private-to-public/utils/get-rtcpeerconnection.ts`
3. **Browser teardown / `hangUp()` PR**
   - focus on `packages/libp2p/src/connection-manager/index.ts`
   - use the shared-dialer browser repro as validation

## Branch intent

This branch is an archival research branch first: it preserves what was tried, what won, and what still appears broken, so the later PRs can be split cleanly without losing the investigation trail.
