import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { RoomState } from './RoomState.js';
import { ClientSession, DeliveryClass } from './ClientSession.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve built frontend assets if dist folder exists
app.use(express.static(distPath));


const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// In-memory Room Store mapping roomId -> RoomState
const rooms = new Map();

export function getOrCreateRoom(roomId = 'default') {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new RoomState(roomId));
  }
  return rooms.get(roomId);
}

// Global System Observability Tracking
let prevCpuUsage = process.cpuUsage();
let prevSampleTime = Date.now();
let lastSecondIngressBytes = 0;
let lastSecondEgressBytes = 0;
let lastSecondIngressUpdates = 0;
let lastSecondEgressMessages = 0;

let rollingIngressBytesPerSec = 0;
let rollingEgressBytesPerSec = 0;
let rollingIngressUpdatesPerSec = 0;
let rollingEgressMessagesPerSec = 0;
let rollingCpuPercent = 0;

setInterval(() => {
  const now = Date.now();
  const elapsedSec = (now - prevSampleTime) / 1000;
  if (elapsedSec > 0) {
    rollingIngressBytesPerSec = Math.round(lastSecondIngressBytes / elapsedSec);
    rollingEgressBytesPerSec = Math.round(lastSecondEgressBytes / elapsedSec);
    rollingIngressUpdatesPerSec = Math.round(lastSecondIngressUpdates / elapsedSec);
    rollingEgressMessagesPerSec = Math.round(lastSecondEgressMessages / elapsedSec);

    const cpuDiff = process.cpuUsage(prevCpuUsage);
    const cpuTotalMicro = cpuDiff.user + cpuDiff.system;
    rollingCpuPercent = ((cpuTotalMicro / (elapsedSec * 1000000)) * 100).toFixed(1);

    prevCpuUsage = process.cpuUsage();
    prevSampleTime = now;
    lastSecondIngressBytes = 0;
    lastSecondEgressBytes = 0;
    lastSecondIngressUpdates = 0;
    lastSecondEgressMessages = 0;
  }
}, 1000);

// =========================================================================
// REST API OBSERVABILITY & HEALTH ENDPOINTS
// =========================================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    roomsCount: rooms.size,
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

app.get('/api/stats', (req, res) => {
  let totalViewers = 0;
  let totalBroadcasters = 0;
  let totalElements = 0;
  let totalQueueDepth = 0;
  let maxQueueDepth = 0;
  let totalCoalesced = 0;
  let totalResyncs = 0;

  for (const r of rooms.values()) {
    const metrics = r.getObservabilityMetrics();
    totalViewers += metrics.viewersCount;
    if (metrics.broadcasterConnected) totalBroadcasters += 1;
    totalElements += metrics.elementCount;
    totalQueueDepth += metrics.queueStats.avgDepth * metrics.viewersCount;
    if (metrics.queueStats.maxDepth > maxQueueDepth) maxQueueDepth = metrics.queueStats.maxDepth;
    totalCoalesced += metrics.stats.coalescedUpdates;
    totalResyncs += metrics.stats.resyncCount;
  }

  const mem = process.memoryUsage();

  res.json({
    system: {
      uptimeSec: process.uptime().toFixed(1),
      cpuPercent: rollingCpuPercent,
      memoryRssMb: (mem.rss / (1024 * 1024)).toFixed(1),
      memoryHeapUsedMb: (mem.heapUsed / (1024 * 1024)).toFixed(1),
      ingressUpdatesPerSec: rollingIngressUpdatesPerSec,
      egressMessagesPerSec: rollingEgressMessagesPerSec,
      ingressMbPerSec: (rollingIngressBytesPerSec / (1024 * 1024)).toFixed(2),
      egressMbPerSec: (rollingEgressBytesPerSec / (1024 * 1024)).toFixed(2),
    },
    roomsCount: rooms.size,
    totalViewers,
    totalBroadcasters,
    totalElements,
    queueStats: {
      avgDepth: totalViewers > 0 ? (totalQueueDepth / totalViewers).toFixed(1) : 0,
      maxDepth: maxQueueDepth,
      totalCoalescedUpdates: totalCoalesced,
      totalResyncs,
    },
    timestamp: Date.now(),
  });
});

app.get('/api/room/:roomId', (req, res) => {
  const room = getOrCreateRoom(req.params.roomId);
  const metrics = room.getObservabilityMetrics();
  res.json({
    ...metrics,
    inUse: room.isBroadcasterActive(),
  });
});

app.get('/api/room/:roomId/status', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms.get(roomId);
  const inUse = Boolean(room && room.isBroadcasterActive());
  res.json({
    roomId,
    inUse,
    broadcasterConnected: inUse,
    viewersCount: room ? room.viewers.size : 0,
    elementCount: room ? room.elementsMap.size : 0,
  });
});

app.post('/__client_log', (req, res) => {
  const data = req.body || {};
  const tag = data.tag || 'CLIENT';
  const ua = data.ua || 'Browser';
  const time = data.time || '';
  const msg = data.msg || '';
  const details = data.details && Object.keys(data.details).length > 0 ? JSON.stringify(data.details) : '';
  const colorUa = ua.includes('iPad') ? '\x1b[35m' : '\x1b[36m';
  console.log(`\x1b[90m[${time}]\x1b[0m ${colorUa}[${ua}]\x1b[0m \x1b[33m[${tag}]\x1b[0m \x1b[1m${msg}\x1b[0m \x1b[32m${details}\x1b[0m`);
  res.json({ ok: true });
});

app.post('/api/room/:roomId/reset', (req, res) => {
  const room = getOrCreateRoom(req.params.roomId);
  room.clear();
  res.json({ status: 'cleared', roomId: room.id, revision: room.revision });
});

// Proxy SFU dashboard and REST API directly to WebRTC SFU (port 3088)
app.use('/sfu', async (req, res) => {
  const sfuPort = process.env.SFU_PORT || 3088;
  const targetPath = req.url === '/' ? '/dashboard' : req.url;
  try {
    const sfuRes = await fetch(`http://127.0.0.1:${sfuPort}${targetPath}`);
    const contentType = sfuRes.headers.get('content-type') || 'text/plain';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = await sfuRes.text();
    res.status(sfuRes.status).send(body);
  } catch (err) {
    res.status(502).json({ error: 'SFU unreachable', details: err.message });
  }
});

app.get('/sfu-dashboard', (req, res) => {
  res.redirect('/sfu/dashboard');
});

// =========================================================================
// WEBSOCKET PROTOCOL & EVENT PIPELINE
// =========================================================================


wss.on('connection', (ws, req) => {
  const remoteIp = req.socket?.remoteAddress;
  const remotePort = req.socket?.remotePort;
  if (remoteIp) {
    console.log(`[WS] Connection established from ${remoteIp}:${remotePort}`);
  }

  let session = null;
  let currentRoom = null;

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    try {
      const msgStr = data.toString();
      const message = JSON.parse(msgStr);
      const rawLength = Buffer.byteLength(msgStr, 'utf8');

      lastSecondIngressBytes += rawLength;
      lastSecondIngressUpdates += 1;

      switch (message.type) {
        case 'join': {
          const roomId = message.roomId || 'default';
          const role = message.role || 'viewer';
          currentRoom = getOrCreateRoom(roomId);

          if (role === 'broadcaster') {
            // Enforce Single-Write Window constraint
            if (currentRoom.isBroadcasterActive() && currentRoom.broadcaster.ws !== ws) {
              console.log(`[Write Limit] Rejected write connection for room ${roomId} - another write window is already active.`);
              ws.send(
                JSON.stringify({
                  type: 'error',
                  code: 'BROADCASTER_LIMIT_EXCEEDED',
                  message: 'Only one write window can be open at a time. Another write window is already active.',
                })
              );
              ws.close(4002, 'Broadcaster limit exceeded');
              return;
            }

            // Clean up any previous broadcaster session
            if (currentRoom.broadcaster && currentRoom.broadcaster.ws !== ws) {
              currentRoom.removeBroadcaster();
            }

            session = new ClientSession(ws, 'broadcaster', roomId);
            currentRoom.setBroadcaster(session);
          } else {
            // Viewers: Add to Room with per-client outbound queue
            session = new ClientSession(ws, 'viewer', roomId);
            currentRoom.addViewer(session);
          }

          // 1. Late Joiner / Init: Send consistent full document snapshot and revision
          currentRoom.sendSnapshotToSession(session);

          // 2. Broadcast presence update to room
          currentRoom.broadcastPresence();
          break;
        }

        case 'batch_update':
        case 'stroke_complete':
        case 'autosave': {
          if (!currentRoom) currentRoom = getOrCreateRoom(message.roomId || 'default');

          // Single Ingestion Pipeline: computes delta, updates canonical document, serializes once, fans out
          currentRoom.processIngressUpdate(message, rawLength);
          lastSecondEgressMessages += currentRoom.viewers.size;
          break;
        }

        case 'cursor':
        case 'ephemeral': {
          // Separate delivery class: ephemeral updates are best-effort (dropped if queue/socket has backlog)
          if (!currentRoom) currentRoom = getOrCreateRoom(message.roomId || 'default');
          currentRoom.processEphemeralUpdate(message, rawLength);
          break;
        }

        case 'request_resync': {
          // Client detected a revision gap or fell behind: deliver clean snapshot
          if (currentRoom && session) {
            currentRoom.sendSnapshotToSession(session);
          }
          break;
        }

        case 'video_rotation': {
          if (!currentRoom) currentRoom = getOrCreateRoom(message.roomId || 'default');
          if (typeof message.videoRotation === 'number') {
            currentRoom.setVideoRotation(message.videoRotation);
          }
          break;
        }

        case 'share_mode': {
          if (!currentRoom) currentRoom = getOrCreateRoom(message.roomId || 'default');
          if (typeof message.activeShare === 'string') {
            currentRoom.setActiveShare(message.activeShare);
          }
          break;
        }

        case 'leave': {
          if (session && currentRoom) {
            if (session.role === 'broadcaster') {
              currentRoom.removeBroadcaster();
              console.log(`[Broadcaster Released] Broadcaster left room ${currentRoom.id}`);
            } else {
              currentRoom.removeViewer(session.id);
            }
            currentRoom.broadcastPresence();
          }
          break;
        }

        case 'clear': {
          if (currentRoom) {
            currentRoom.clear();
          }
          break;
        }

        case 'ping': {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'pong',
                clientTime: message.clientTime,
                serverTime: Date.now(),
              })
            );
          }
          break;
        }
      }
    } catch (err) {
      console.error('WebSocket message handling error:', err);
    }
  });

  ws.on('close', () => {
    // Ensure broadcaster release if this socket was the registered broadcaster
    for (const [rId, room] of rooms.entries()) {
      if (room.broadcaster && (room.broadcaster.ws === ws || room.broadcaster === session)) {
        room.removeBroadcaster();
        room.broadcastPresence();
        console.log(`[Broadcaster Released] Released broadcaster on socket close for room ${rId}`);
      }
      if (session && room.viewers.has(session.id)) {
        room.removeViewer(session.id);
        room.broadcastPresence();
      }
    }
    if (session) {
      session.close();
    }
  });
});

// SPA routing fallback for Express when serving static dist
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
    return res.sendFile(path.join(distPath, 'index.html'));
  }
  next();
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`🚀 ExcaliStream server running on http://${HOST}:${PORT}`);
  console.log(`📡 WebSocket endpoint at ws://${HOST}:${PORT}/ws`);
  console.log(`📊 Observability metrics at http://${HOST}:${PORT}/api/stats`);
});
