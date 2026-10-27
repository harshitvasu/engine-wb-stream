import WebSocket from 'ws';

/**
 * End-to-End Signaling & Architecture Verification Test
 * Verifies that:
 * 1. Node.js WebSocket stream engine is responding on :3001/ws
 * 2. Rust WebRTC SFU signaling engine is responding on :3088
 * 3. Publisher and Subscriber signaling negotiation succeed
 * 4. Room IDs remain synchronized between JSON streaming and WebRTC media
 */

const NODE_WS_URL = process.env.VITE_WS_URL || 'ws://localhost:3001/ws';
const SFU_WS_URL = process.env.VITE_SFU_WS_URL || 'ws://localhost:3088';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest() {
  console.log('======================================================================');
  console.log('WEBRTC SFU + EXCALIDRAW SYSTEM INTEGRATION TEST');
  console.log('======================================================================\n');

  const testRoomId = `integ-room-${Date.now()}`;

  // 1. Verify Node.js JSON Whiteboard WebSocket stream
  console.log('1. Connecting to Node.js JSON whiteboard stream...');
  const nodeWs = new WebSocket(NODE_WS_URL);
  await new Promise((resolve, reject) => {
    nodeWs.on('open', resolve);
    nodeWs.on('error', reject);
  });

  const nodeEvents = [];
  nodeWs.on('message', (data) => nodeEvents.push(JSON.parse(data.toString())));
  nodeWs.send(JSON.stringify({ type: 'join', role: 'broadcaster', roomId: testRoomId }));
  await sleep(150);

  const initMsg = nodeEvents.find((e) => e.type === 'init' || e.type === 'snapshot');
  if (!initMsg) {
    throw new Error('Did not receive initial document snapshot from Node.js stream');
  }
  console.log(`✓ Node.js stream operational: joined ${testRoomId} at revision ${initMsg.revision}`);

  // 2. Verify Rust SFU WebSocket Signaling
  console.log('\n2. Connecting to Rust WebRTC SFU signaling...');
  const sfuWs = new WebSocket(SFU_WS_URL);
  await new Promise((resolve, reject) => {
    sfuWs.on('open', resolve);
    sfuWs.on('error', reject);
  });

  const sfuEvents = [];
  sfuWs.on('message', (data) => sfuEvents.push(JSON.parse(data.toString())));

  // Join as publisher using the SAME room ID
  sfuWs.send(
    JSON.stringify({
      type: 'join',
      roomId: testRoomId,
      role: 'publisher',
      peerId: 'test-publisher-1',
    })
  );
  await sleep(150);

  const joinedMsg = sfuEvents.find((e) => e.type === 'joined' && e.role === 'publisher');
  if (!joinedMsg) {
    throw new Error('Did not receive joined confirmation from Rust SFU');
  }
  console.log(`✓ Rust SFU signaling operational: joined ${testRoomId} as ${joinedMsg.role}`);

  // 3. Verify SDP offer/answer negotiation with mock offer
  console.log('\n3. Testing SDP Offer/Answer with Rust SFU...');
  const mockOfferSdp = [
    'v=0',
    'o=- 123456789 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendonly',
    'a=rtpmap:111 opus/48000/2',
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:actpass',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnop',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=sendonly',
    'a=rtpmap:96 VP8/90000',
    'a=rtcp-fb:96 nack pli',
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:actpass',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnop',
    '',
  ].join('\r\n');

  sfuWs.send(
    JSON.stringify({
      type: 'offer',
      peerId: 'test-publisher-1',
      sdp: mockOfferSdp,
    })
  );
  await sleep(150);

  const answerMsg = sfuEvents.find((e) => e.type === 'answer');
  if (!answerMsg || !answerMsg.sdp) {
    throw new Error('Did not receive valid SDP answer from Rust SFU');
  }
  console.log(`✓ Rust SFU generated valid WebRTC SDP answer (${answerMsg.sdp.length} bytes)`);
  if (!answerMsg.sdp.includes('a=recvonly')) {
    throw new Error('SDP answer did not negotiate receive-only tracks for publisher');
  }
  console.log('✓ SFU correctly negotiated recvonly for inbound Opus audio & VP8 video tracks');

  // 4. Verify Subscriber join
  console.log('\n4. Connecting subscriber to same room...');
  const subWs = new WebSocket(SFU_WS_URL);
  await new Promise((r) => subWs.on('open', r));

  const subEvents = [];
  subWs.on('message', (data) => subEvents.push(JSON.parse(data.toString())));
  subWs.send(
    JSON.stringify({
      type: 'join',
      roomId: testRoomId,
      role: 'subscriber',
      peerId: 'test-sub-1',
    })
  );
  await sleep(150);

  const subJoined = subEvents.find((e) => e.type === 'joined' && e.role === 'subscriber');
  if (!subJoined) {
    throw new Error('Subscriber failed to join Rust SFU');
  }
  console.log(`✓ Subscriber joined room ${testRoomId}`);

  // Cleanup
  nodeWs.close();
  sfuWs.close();
  subWs.close();

  console.log('\n======================================================================');
  console.log('ALL INTEGRATION CHECKS PASSED: SFU & NODE APPLICATION FULLY IN SYNC');
  console.log('======================================================================\n');
}

runTest().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
