import { setSctpSettings } from 'node-datachannel'

setSctpSettings({
  sendBufferSize: 6 * 1024 * 1024,
  recvBufferSize: 4 * 1024 * 1024,
  congestionControlModule: 1
})

export { RTCSessionDescription, RTCIceCandidate, RTCPeerConnection } from 'node-datachannel/polyfill'
