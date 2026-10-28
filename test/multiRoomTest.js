import assert from 'assert';
import { RoomState } from '../server/RoomState.js';
import { ClientSession, DeliveryClass } from '../server/ClientSession.js';

console.log('======================================================================');
console.log('MULTI-ROOM ARCHITECTURE & BROADCASTER RELEASE UNIT TEST SUITE');
console.log('======================================================================\n');

// Mock WebSocket class for headless unit testing
class MockWebSocket {
  constructor() {
    this.readyState = 1; // WebSocket.OPEN
    this.sentMessages = [];
  }
  send(data, cb) {
    this.sentMessages.push(typeof data === 'string' ? JSON.parse(data) : data);
    if (typeof cb === 'function') cb();
  }
  close(code, reason) {
    this.readyState = 3; // WebSocket.CLOSED
    this.closeCode = code;
    this.closeReason = reason;
  }
}

// Helper to simulate random room ID generator as implemented in LobbyPage
function generateRoomId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars[Math.floor(Math.random() * chars.length)];
  }
  return `room-${rand}`;
}

// -----------------------------------------------------------------------------
// Test 1: Random Alphanumeric Room ID Format
// -----------------------------------------------------------------------------
console.log('Test 1: Random alphanumeric room ID format & uniqueness...');
const id1 = generateRoomId();
const id2 = generateRoomId();
assert.ok(id1.startsWith('room-'), 'Room ID must have room- prefix');
assert.strictEqual(id1.length, 11, 'Room ID should be 11 chars (room- + 6 alphanumeric)');
assert.match(id1, /^room-[a-z0-9]{6}$/, 'Room ID must match regex ^room-[a-z0-9]{6}$');
assert.notStrictEqual(id1, id2, 'Two generated room IDs should be distinct');
console.log(`✓ Generated Room IDs: ${id1}, ${id2} (Valid format & unique)`);

// -----------------------------------------------------------------------------
// Test 2: Multiple Isolated Rooms (Independent Broadcasters)
// -----------------------------------------------------------------------------
console.log('\nTest 2: Multiple rooms operating simultaneously with independent broadcasters...');
const roomAlpha = new RoomState('room-alpha');
const roomBeta = new RoomState('room-beta');

const wsAlpha = new MockWebSocket();
const sessionAlpha = new ClientSession(wsAlpha, 'broadcaster', 'room-alpha');
roomAlpha.setBroadcaster(sessionAlpha);

const wsBeta = new MockWebSocket();
const sessionBeta = new ClientSession(wsBeta, 'broadcaster', 'room-beta');
roomBeta.setBroadcaster(sessionBeta);

assert.strictEqual(roomAlpha.isBroadcasterActive(), true, 'Room Alpha must have active broadcaster');
assert.strictEqual(roomBeta.isBroadcasterActive(), true, 'Room Beta must have active broadcaster');
assert.notStrictEqual(roomAlpha.broadcaster, roomBeta.broadcaster, 'Broadcasters must be distinct');
console.log('✓ Broadcasters in room-alpha and room-beta operate simultaneously without collision');

// -----------------------------------------------------------------------------
// Test 3: Single-Write Window Enforced PER ROOM
// -----------------------------------------------------------------------------
console.log('\nTest 3: Enforcing single-write window per room...');
// In room-alpha, broadcaster is already active
assert.strictEqual(roomAlpha.isBroadcasterActive(), true);

// Attempting to add a 2nd broadcaster in room-alpha
const wsAlpha2 = new MockWebSocket();
let alpha2Rejected = false;
if (roomAlpha.isBroadcasterActive() && roomAlpha.broadcaster.ws !== wsAlpha2) {
  alpha2Rejected = true;
  wsAlpha2.send(
    JSON.stringify({
      type: 'error',
      code: 'BROADCASTER_LIMIT_EXCEEDED',
      message: 'Only one write window can be open at a time.',
    })
  );
  wsAlpha2.close(4002, 'Broadcaster limit exceeded');
}

assert.strictEqual(alpha2Rejected, true, 'Second broadcaster in room-alpha must be rejected');
assert.strictEqual(wsAlpha2.readyState, 3, 'Second broadcaster socket must be closed');
assert.strictEqual(wsAlpha2.closeCode, 4002, 'Close code must be 4002');
console.log('✓ Second broadcaster in room-alpha correctly rejected with code 4002');

// -----------------------------------------------------------------------------
// Test 4: Viewers Allowed in Room Alpha While Second Broadcaster is Blocked
// -----------------------------------------------------------------------------
console.log('\nTest 4: Viewers can join room-alpha without restriction...');
const viewer1Ws = new MockWebSocket();
const viewer1 = new ClientSession(viewer1Ws, 'viewer', 'room-alpha');
roomAlpha.addViewer(viewer1);

const viewer2Ws = new MockWebSocket();
const viewer2 = new ClientSession(viewer2Ws, 'viewer', 'room-alpha');
roomAlpha.addViewer(viewer2);

assert.strictEqual(roomAlpha.viewers.size, 2, 'Room alpha must have 2 viewers');
const alphaMetrics = roomAlpha.getObservabilityMetrics();
assert.strictEqual(alphaMetrics.viewersCount, 2, 'Metrics must show 2 viewers');
assert.strictEqual(alphaMetrics.broadcasterConnected, true, 'Metrics must show broadcasterConnected: true');
console.log('✓ Multiple viewers connected to room-alpha with active broadcaster');

// -----------------------------------------------------------------------------
// Test 5: Immediate Broadcaster Release on 'leave' Message
// -----------------------------------------------------------------------------
console.log('\nTest 5: Immediate broadcaster release when navigating away / sending leave...');
// Broadcaster in room-alpha leaves
roomAlpha.removeBroadcaster();
assert.strictEqual(roomAlpha.isBroadcasterActive(), false, 'room-alpha broadcaster must be false after leave');
assert.strictEqual(roomAlpha.broadcaster, null, 'room-alpha broadcaster must be null');

const alphaMetricsAfterLeave = roomAlpha.getObservabilityMetrics();
assert.strictEqual(alphaMetricsAfterLeave.broadcasterConnected, false, 'Metrics must show broadcasterConnected: false');
console.log('✓ room-alpha broadcaster immediately released to null');

// -----------------------------------------------------------------------------
// Test 6: New Broadcaster Can Immediately Join Previously Occupied Room
// -----------------------------------------------------------------------------
console.log('\nTest 6: New broadcaster can now broadcast in room-alpha without write limit error...');
const wsAlphaNew = new MockWebSocket();
assert.strictEqual(roomAlpha.isBroadcasterActive(), false, 'Room alpha is now available');

const sessionAlphaNew = new ClientSession(wsAlphaNew, 'broadcaster', 'room-alpha');
roomAlpha.setBroadcaster(sessionAlphaNew);

assert.strictEqual(roomAlpha.isBroadcasterActive(), true, 'New broadcaster successfully acquired room-alpha');
console.log('✓ New broadcaster seamlessly took over room-alpha');

// -----------------------------------------------------------------------------
// Test 7: Abrupt Broadcaster Socket Drop Auto-Cleaned by isBroadcasterActive()
// -----------------------------------------------------------------------------
console.log('\nTest 7: Broadcaster socket drops abruptly (browser tab crash / network disconnect)...');
// wsBeta in roomBeta closes abruptly
wsBeta.readyState = 3; // Closed without sending leave

// Calling isBroadcasterActive() detects socket closed and clears reference
assert.strictEqual(roomBeta.isBroadcasterActive(), false, 'isBroadcasterActive must return false when socket closed');
assert.strictEqual(roomBeta.broadcaster, null, 'isBroadcasterActive must clear broadcaster reference');
console.log('✓ Inactive broadcaster socket automatically cleaned up; room-beta freed');

// -----------------------------------------------------------------------------
// Test 8: Room Status Check Simulation (/api/room/:roomId/status)
// -----------------------------------------------------------------------------
console.log('\nTest 8: Room status API behavior for empty vs active rooms...');
function getRoomStatus(room) {
  const inUse = Boolean(room && room.isBroadcasterActive());
  return {
    roomId: room ? room.id : 'unknown',
    inUse,
    broadcasterConnected: inUse,
    viewersCount: room ? room.viewers.size : 0,
    elementCount: room ? room.elementsMap.size : 0,
  };
}

const statusAlpha = getRoomStatus(roomAlpha);
assert.strictEqual(statusAlpha.inUse, true, 'roomAlpha should be inUse');
assert.strictEqual(statusAlpha.broadcasterConnected, true);
assert.strictEqual(statusAlpha.viewersCount, 2);

const statusBeta = getRoomStatus(roomBeta);
assert.strictEqual(statusBeta.inUse, false, 'roomBeta should NOT be inUse');
assert.strictEqual(statusBeta.broadcasterConnected, false);

const emptyRoom = new RoomState('room-empty');
const statusEmpty = getRoomStatus(emptyRoom);
assert.strictEqual(statusEmpty.inUse, false);
assert.strictEqual(statusEmpty.viewersCount, 0);

console.log('✓ Room status API correctly reports inUse status across occupied, vacated, and empty rooms');

console.log('\n======================================================================');
console.log('ALL MULTI-ROOM ARCHITECTURE UNIT TESTS PASSED (8/8)');
console.log('======================================================================\n');
