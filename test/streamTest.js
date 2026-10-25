import WebSocket from 'ws';

async function runTest() {
  console.log('--- Starting ExcaliStream Invariant Test (1 Write Window Max + Multiple Simultaneous Stream Viewers) ---');

  const wsUrl = 'ws://localhost:3001/ws';
  const broadcaster1 = new WebSocket(wsUrl);

  await new Promise((resolve) => broadcaster1.on('open', resolve));
  broadcaster1.send(JSON.stringify({ type: 'join', role: 'broadcaster', roomId: 'test-room' }));
  console.log('✓ Broadcaster 1 connected and joined as active write window');

  await new Promise((r) => setTimeout(r, 200));

  // 1. Test Single-Write Window Enforcement:
  // Broadcaster 2 attempts to connect -> MUST BE REJECTED with BROADCASTER_LIMIT_EXCEEDED!
  console.log('\n--- Testing Single-Write Window Enforcement (Rejecting 2nd write window) ---');
  const broadcaster2 = new WebSocket(wsUrl);
  await new Promise((resolve) => broadcaster2.on('open', resolve));

  const broadcaster2Events = [];
  let broadcaster2ClosedCode = null;
  broadcaster2.on('message', (data) => {
    broadcaster2Events.push(JSON.parse(data.toString()));
  });
  broadcaster2.on('close', (code) => {
    broadcaster2ClosedCode = code;
  });

  broadcaster2.send(JSON.stringify({ type: 'join', role: 'broadcaster', roomId: 'test-room' }));

  await new Promise((r) => setTimeout(r, 300));

  const errorMsg = broadcaster2Events.find((e) => e.type === 'error' && e.code === 'BROADCASTER_LIMIT_EXCEEDED');
  if (!errorMsg) {
    throw new Error('Broadcaster 2 was NOT rejected when opening a second write window!');
  }
  console.log(`✓ Broadcaster 2 was correctly rejected with error: "${errorMsg.message}"`);
  console.log(`✓ Broadcaster 2 socket was closed with code: ${broadcaster2ClosedCode} (expected 4002)`);

  if (broadcaster2ClosedCode !== 4002) {
    throw new Error(`Expected close code 4002 for rejected write window, got ${broadcaster2ClosedCode}`);
  }

  // 2. Test Multiple Simultaneous Stream Windows:
  // Connect Viewer 1, Viewer 2, and Viewer 3 simultaneously -> ALL MUST SUCCEED!
  console.log('\n--- Testing Multiple Simultaneous Stream Windows (All must succeed) ---');
  const viewer1 = new WebSocket(wsUrl);
  const viewer2 = new WebSocket(wsUrl);
  const viewer3 = new WebSocket(wsUrl);

  await Promise.all([
    new Promise((resolve) => viewer1.on('open', resolve)),
    new Promise((resolve) => viewer2.on('open', resolve)),
    new Promise((resolve) => viewer3.on('open', resolve)),
  ]);

  const v1Events = [], v2Events = [], v3Events = [];
  viewer1.on('message', (d) => v1Events.push(JSON.parse(d.toString())));
  viewer2.on('message', (d) => v2Events.push(JSON.parse(d.toString())));
  viewer3.on('message', (d) => v3Events.push(JSON.parse(d.toString())));

  viewer1.send(JSON.stringify({ type: 'join', role: 'viewer', roomId: 'test-room' }));
  viewer2.send(JSON.stringify({ type: 'join', role: 'viewer', roomId: 'test-room' }));
  viewer3.send(JSON.stringify({ type: 'join', role: 'viewer', roomId: 'test-room' }));

  await new Promise((r) => setTimeout(r, 300));

  if (!v1Events.some((e) => e.type === 'init')) throw new Error('Viewer 1 failed to initialize');
  if (!v2Events.some((e) => e.type === 'init')) throw new Error('Viewer 2 failed to initialize');
  if (!v3Events.some((e) => e.type === 'init')) throw new Error('Viewer 3 failed to initialize');
  console.log('✓ All 3 stream viewers connected simultaneously without error!');

  // 3. Test that broadcast streams to all simultaneous viewers
  console.log('\n--- Testing 16ms broadcast to all simultaneous stream viewers ---');
  const strokeElement = {
    id: 'stroke-multi',
    type: 'freedraw',
    points: [[0, 0], [10, 10], [20, 15]],
    x: 50,
    y: 50,
  };

  broadcaster1.send(
    JSON.stringify({
      type: 'batch_update',
      roomId: 'test-room',
      elements: [strokeElement],
      sequence: 1,
      timestamp: Date.now(),
    })
  );

  await new Promise((r) => setTimeout(r, 200));

  if (!v1Events.some((e) => e.type === 'batch_update')) throw new Error('Viewer 1 did not receive batch');
  if (!v2Events.some((e) => e.type === 'batch_update')) throw new Error('Viewer 2 did not receive batch');
  if (!v3Events.some((e) => e.type === 'batch_update')) throw new Error('Viewer 3 did not receive batch');
  console.log('✓ All 3 simultaneous viewers received the streamed batch!');

  // 4. Test that when Broadcaster 1 disconnects, a new write window can claim it
  console.log('\n--- Testing Reconnection of write window after previous closes ---');
  broadcaster1.close();
  await new Promise((r) => setTimeout(r, 200));

  const broadcaster3 = new WebSocket(wsUrl);
  await new Promise((resolve) => broadcaster3.on('open', resolve));
  const b3Events = [];
  broadcaster3.on('message', (d) => b3Events.push(JSON.parse(d.toString())));
  broadcaster3.send(JSON.stringify({ type: 'join', role: 'broadcaster', roomId: 'test-room' }));

  await new Promise((r) => setTimeout(r, 200));
  if (!b3Events.some((e) => e.type === 'init')) {
    throw new Error('New write window failed to connect after Broadcaster 1 closed!');
  }
  console.log('✓ New write window successfully connected after previous write window closed!');

  console.log('\n✓ ALL INVARIANT CHECKS PASSED (1 Write Window Max + Multiple Stream Viewers Allowed)!\n');

  viewer1.close();
  viewer2.close();
  viewer3.close();
  broadcaster3.close();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('Test FAILED:', err);
  process.exit(1);
});
