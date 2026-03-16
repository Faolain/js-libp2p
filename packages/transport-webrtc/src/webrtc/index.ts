import { setSctpSettings } from 'node-datachannel'

setSctpSettings({
  sendBufferSize: 3 * 1024 * 1024,
  recvBufferSize: 2 * 1024 * 1024,
  congestionControlModule: 1
})

export { RTCSessionDescription, RTCIceCandidate, RTCPeerConnection } from 'node-datachannel/polyfill'
