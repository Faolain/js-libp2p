#!/usr/bin/env bash
set -euo pipefail

npm --workspace packages/transport-webrtc run test:node >/dev/null
