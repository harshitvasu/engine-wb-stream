import { DeliveryClass } from './ClientSession.js';

/**
 * RoomState
 * Canonical document state holder and single-ingestion event pipeline for an Excalidraw room.
 * Computes incremental deltas, manages revisions, and coordinates batched fan-out with per-client queues.
 */
export class RoomState {
  constructor(roomId = 'default', options = {}) {
    this.id = roomId;
    this.elementsMap = new Map();
    this.appState = {
      viewBackgroundColor: '#ffffff',
      zoom: { value: 1.0 },
      scrollX: 0,
      scrollY: 0,
      width: 1600,
      height: 900,
    };
    this.revision = 0;
    this.videoRotation = 0; // Broadcaster video orientation angle in degrees (0, 90, 180, 270)
    this.activeShare = 'whiteboard'; // Active presentation stream: 'whiteboard' | 'screen' | 'video'
    this.lastAutosave = Date.now();
    this.createdAt = Date.now();

    // Client Sessions
    this.broadcaster = null; // Single active writer session
    this.viewers = new Map(); // Map<string, ClientSession>

    // Batching Configuration
    this.batchIntervalMs = options.batchIntervalMs || 16;
    this.pendingChangedElements = new Map();
    this.pendingDeletedIds = new Set();
    this.pendingAppState = null;
    this.pendingSequence = 0;
    this.batchTimer = null;

    // Observability Counters
    this.stats = {
      batchesProcessed: 0,
      strokesCompleted: 0,
      autosavesReceived: 0,
      bytesIngress: 0,
      bytesEgress: 0,
      patchesSent: 0,
      snapshotsSent: 0,
      ephemeralDropped: 0,
      coalescedUpdates: 0,
    };
  }

  /**
   * Sets or replaces the single active broadcaster session.
   */
  setBroadcaster(session) {
    this.broadcaster = session;
  }

  removeBroadcaster() {
    this.broadcaster = null;
  }

  /**
   * Adds a viewer session with automatic snapshot resync callback.
   */
  addViewer(session) {
    session.onResyncNeeded = (s) => this.sendSnapshotToSession(s);
    this.viewers.set(session.id, session);
  }

  removeViewer(sessionId) {
    this.viewers.delete(sessionId);
  }

  /**
   * Generates a full document snapshot for late joiners or resynchronization.
   */
  getSnapshot(type = 'init') {
    return {
      type, // 'init' on join for backward compatibility, or 'snapshot' on resync
      snapshotType: 'snapshot',
      roomId: this.id,
      revision: this.revision,
      elements: Array.from(this.elementsMap.values()),
      appState: this.appState,
      videoRotation: this.videoRotation,
      activeShare: this.activeShare || 'whiteboard',
      timestamp: Date.now(),
      stats: {
        viewersCount: this.viewers.size,
        broadcastersCount: this.broadcaster ? 1 : 0,
      },
    };
  }

  /**
   * Updates broadcaster video rotation and broadcasts the new orientation to all viewers.
   */
  setVideoRotation(rotation) {
    this.videoRotation = ((rotation % 360) + 360) % 360;
    const msg = {
      type: 'video_rotation',
      roomId: this.id,
      videoRotation: this.videoRotation,
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(msg);
    const bytes = Buffer.byteLength(raw, 'utf8');

    for (const viewer of this.viewers.values()) {
      const ok = viewer.enqueue(msg, raw, DeliveryClass.RELIABLE);
      if (ok) {
        this.stats.bytesEgress += bytes;
      }
    }
  }

  /**
   * Updates active broadcast presentation share mode ('whiteboard' | 'screen' | 'video')
   * and broadcasts the mode change to all viewers in the room.
   */
  setActiveShare(mode) {
    const validModes = ['whiteboard', 'screen', 'video'];
    this.activeShare = validModes.includes(mode) ? mode : 'whiteboard';
    const msg = {
      type: 'share_mode',
      roomId: this.id,
      activeShare: this.activeShare,
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(msg);
    const bytes = Buffer.byteLength(raw, 'utf8');

    for (const viewer of this.viewers.values()) {
      const ok = viewer.enqueue(msg, raw, DeliveryClass.RELIABLE);
      if (ok) {
        this.stats.bytesEgress += bytes;
      }
    }
  }

  /**
   * Directly sends a full snapshot to a specific client session.
   */
  sendSnapshotToSession(session, type = 'init') {
    const snapshot = this.getSnapshot(type);
    const raw = JSON.stringify(snapshot);
    this.stats.snapshotsSent += 1;
    this.stats.bytesEgress += Buffer.byteLength(raw, 'utf8');
    session.enqueue(snapshot, raw, DeliveryClass.RELIABLE);
  }

  /**
   * Broadcasts presence information to all clients.
   */
  broadcastPresence() {
    const presenceMsg = {
      type: 'presence',
      roomId: this.id,
      viewersCount: this.viewers.size,
      broadcastersCount: this.broadcaster ? 1 : 0,
      revision: this.revision,
    };
    const raw = JSON.stringify(presenceMsg);

    if (this.broadcaster) {
      this.broadcaster.enqueue(presenceMsg, raw, DeliveryClass.RELIABLE);
    }
    for (const viewer of this.viewers.values()) {
      viewer.enqueue(presenceMsg, raw, DeliveryClass.RELIABLE);
    }
  }

  /**
   * Single Ingestion Pipeline:
   * Ingests drawing updates once, computes incremental changes (deltas),
   * updates the canonical document, serializes the patch once, and fans out to client queues.
   */
  processIngressUpdate(message, rawLength = 0) {
    this.stats.bytesIngress += rawLength;

    if (message.type === 'stroke_complete') {
      this.stats.strokesCompleted += 1;
    } else if (message.type === 'autosave') {
      this.stats.autosavesReceived += 1;
    } else {
      this.stats.batchesProcessed += 1;
    }

    const changedElements = [];
    const deletedIds = [];

    // 1. Compute Incremental Deltas against Canonical elementsMap
    if (Array.isArray(message.elements)) {
      for (const el of message.elements) {
        if (!el || !el.id) continue;

        const existing = this.elementsMap.get(el.id);
        const isNew = !existing;
        let isUpdated = false;

        if (existing) {
          if (el.version !== undefined && existing.version !== undefined) {
            isUpdated = el.version > existing.version || el.isDeleted !== existing.isDeleted;
          } else {
            // Fallback for unversioned test mocks
            isUpdated = JSON.stringify(el) !== JSON.stringify(existing);
          }
        }

        if (isNew || isUpdated) {
          this.elementsMap.set(el.id, el);

          if (el.isDeleted) {
            deletedIds.push(el.id);
          } else {
            changedElements.push(el);
          }
        }
      }

      // If broadcaster explicitly transmitted elements but none had version increments,
      // include the transmitted elements so callers with custom payload formats are never ignored
      if (changedElements.length === 0 && deletedIds.length === 0 && message.elements.length > 0) {
        changedElements.push(...message.elements);
      }
    }

    // 2. Update canonical AppState (zoom, pan, view background)
    if (message.appState) {
      this.appState = { ...this.appState, ...message.appState };
    }

    const isFinalStroke = Boolean(message.isFinal || message.type === 'stroke_complete');

    // If nothing changed and this is not a final stroke update or autosave, skip redundant fan-out
    if (changedElements.length === 0 && deletedIds.length === 0 && !message.appState && !isFinalStroke) {
      return;
    }

    // 3. Increment Monotonic Revision
    this.revision += 1;

    // 4. Construct Incremental Patch Object
    const patchObj = {
      type: isFinalStroke ? 'stroke_complete' : (message.type === 'batch_update' ? 'batch_update' : 'patch'),
      isPatch: true,
      roomId: this.id,
      revision: this.revision,
      elements: changedElements, // ONLY changed elements sent over network!
      deletedIds,
      appState: message.appState,
      sequence: message.sequence || this.revision,
      timestamp: message.timestamp || Date.now(),
      isFinal: isFinalStroke,
      broadcasterStats: message.broadcasterStats,
    };

    // 5. Serialize ONCE for all recipients
    const serialized = JSON.stringify(patchObj);
    const serializedBytes = Buffer.byteLength(serialized, 'utf8');
    this.stats.patchesSent += 1;

    // 6. Batched Fan-Out to per-client outbound queues
    for (const viewer of this.viewers.values()) {
      const ok = viewer.enqueue(patchObj, serialized, DeliveryClass.RELIABLE);
      if (ok) {
        this.stats.bytesEgress += serializedBytes;
      }
    }
  }

  /**
   * Broadcasts ephemeral updates (such as cursor positions or hover previews)
   * with best-effort delivery class (dropped on lagging clients).
   */
  processEphemeralUpdate(message, rawLength = 0) {
    this.stats.bytesIngress += rawLength;
    const raw = JSON.stringify(message);
    const bytes = Buffer.byteLength(raw, 'utf8');

    for (const viewer of this.viewers.values()) {
      const ok = viewer.enqueue(message, raw, DeliveryClass.EPHEMERAL);
      if (ok) {
        this.stats.bytesEgress += bytes;
      } else {
        this.stats.ephemeralDropped += 1;
      }
    }
  }

  /**
   * Clears room canvas, resets canonical state, and fans out clear event.
   */
  clear() {
    this.elementsMap.clear();
    this.revision += 1;
    this.lastAutosave = Date.now();

    const clearObj = {
      type: 'clear',
      roomId: this.id,
      revision: this.revision,
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(clearObj);
    const bytes = Buffer.byteLength(raw, 'utf8');

    for (const viewer of this.viewers.values()) {
      viewer.enqueue(clearObj, raw, DeliveryClass.RELIABLE);
      this.stats.bytesEgress += bytes;
    }
  }

  /**
   * Aggregate metrics and observability counters.
   */
  getObservabilityMetrics() {
    let totalQueueDepth = 0;
    let minQueueDepth = Infinity;
    let maxQueueDepth = 0;
    let totalQueuedBytes = 0;
    let totalCoalesced = 0;
    let totalResyncs = 0;

    const viewerStats = [];

    for (const viewer of this.viewers.values()) {
      const s = viewer.getStats();
      viewerStats.push(s);
      totalQueueDepth += s.queueDepth;
      totalQueuedBytes += s.queuedBytes;
      totalCoalesced += s.coalescedCount;
      totalResyncs += s.resyncCount;

      if (s.queueDepth < minQueueDepth) minQueueDepth = s.queueDepth;
      if (s.queueDepth > maxQueueDepth) maxQueueDepth = s.queueDepth;
    }

    const viewerCount = this.viewers.size;
    const avgQueueDepth = viewerCount > 0 ? (totalQueueDepth / viewerCount).toFixed(1) : 0;
    if (minQueueDepth === Infinity) minQueueDepth = 0;

    return {
      roomId: this.id,
      revision: this.revision,
      elementCount: this.elementsMap.size,
      viewersCount: viewerCount,
      broadcasterConnected: Boolean(this.broadcaster),
      queueStats: {
        minDepth: minQueueDepth,
        avgDepth: Number(avgQueueDepth),
        maxDepth: maxQueueDepth,
        totalQueuedBytes,
      },
      stats: {
        ...this.stats,
        coalescedUpdates: totalCoalesced,
        resyncCount: totalResyncs,
      },
      viewers: viewerStats,
    };
  }
}
