import { WebSocket } from 'ws';

export const DeliveryClass = {
  RELIABLE: 'reliable',
  EPHEMERAL: 'ephemeral',
};

/**
 * ClientSession
 * Wraps each connected WebSocket client with an independent bounded outbound queue,
 * non-blocking async sender loop, per-client backpressure monitoring, and element update coalescing.
 */
export class ClientSession {
  constructor(ws, role = 'viewer', roomId = 'default', options = {}) {
    this.ws = ws;
    this.role = role;
    this.roomId = roomId;
    this.id = Math.random().toString(36).substring(2, 9);
    this.connectedAt = Date.now();

    // Configurable Queue Constraints
    this.maxQueueDepth = options.maxQueueDepth || 60; // Max pending messages
    this.maxQueueBytes = options.maxQueueBytes || 1024 * 1024; // 1 MB queue limit
    this.highWatermarkBytes = options.highWatermarkBytes || 256 * 1024; // 256 KB socket buffer watermark

    // Queue storage: FIFO array of queued items
    this.queue = [];
    this.queuedBytes = 0;
    this.isSending = false;
    this.needsResync = false;
    this.isClosed = false;

    // Resync hook provided by RoomState
    this.onResyncNeeded = options.onResyncNeeded || null;

    // Telemetry & Observability
    this.metrics = {
      sentMessages: 0,
      sentBytes: 0,
      coalescedCount: 0,
      droppedEphemeral: 0,
      resyncCount: 0,
      lastSendLatencyMs: 0,
    };
  }

  /**
   * Enqueues an outgoing message with delivery class awareness and coalescing.
   * @param {Object} messageObj - The parsed message structure
   * @param {string} rawSerialized - Pre-serialized JSON string (serialized once on server)
   * @param {string} deliveryClass - DeliveryClass.RELIABLE or DeliveryClass.EPHEMERAL
   */
  enqueue(messageObj, rawSerialized, deliveryClass = DeliveryClass.RELIABLE) {
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const payloadBytes = Buffer.byteLength(rawSerialized, 'utf8');

    // 1. Separate Delivery Classes:
    // Ephemeral messages (e.g. cursor moves, hover previews) are best-effort:
    // If the client has any queued backlog or socket is buffering, drop immediately.
    if (deliveryClass === DeliveryClass.EPHEMERAL) {
      if (this.queue.length > 0 || (this.ws.bufferedAmount && this.ws.bufferedAmount > 0)) {
        this.metrics.droppedEphemeral += 1;
        return false;
      }
    }

    // 2. Backpressure Coalescing for Reliable Updates:
    // If client is lagging and has pending patches in queue, coalesce updates for the same elements.
    if (
      deliveryClass === DeliveryClass.RELIABLE &&
      (messageObj.type === 'patch' || messageObj.type === 'batch_update') &&
      this.queue.length > 0
    ) {
      const lastItem = this.queue[this.queue.length - 1];
      if (lastItem && (lastItem.type === 'patch' || lastItem.type === 'batch_update') && !lastItem.isFinal) {
        // Coalesce into existing queued patch
        const elementMap = new Map();
        if (Array.isArray(lastItem.message.elements)) {
          for (const el of lastItem.message.elements) {
            elementMap.set(el.id, el);
          }
        }
        if (Array.isArray(messageObj.elements)) {
          for (const el of messageObj.elements) {
            elementMap.set(el.id, el); // Replace with newer element version
          }
        }

        const mergedElements = Array.from(elementMap.values());
        const mergedObj = {
          ...lastItem.message,
          elements: mergedElements,
          revision: messageObj.revision || lastItem.message.revision,
          sequence: messageObj.sequence || lastItem.message.sequence,
          timestamp: messageObj.timestamp || lastItem.message.timestamp,
          appState: messageObj.appState || lastItem.message.appState,
          isFinal: Boolean(messageObj.isFinal),
        };

        const newRaw = JSON.stringify(mergedObj);
        const newBytes = Buffer.byteLength(newRaw, 'utf8');

        this.queuedBytes += (newBytes - lastItem.rawBytes);
        lastItem.message = mergedObj;
        lastItem.raw = newRaw;
        lastItem.rawBytes = newBytes;
        lastItem.type = mergedObj.type;
        lastItem.isFinal = mergedObj.isFinal;
        this.metrics.coalescedCount += 1;

        this.drainQueue();
        return true;
      }
    }

    // 3. Queue Limit Enforcement & Resync Backpressure Policy:
    // If the queue exceeds capacity, drop stale backlog and mark client as requiring a full snapshot.
    // This protects server memory and prevents slow clients from stalling the room.
    if (this.queue.length >= this.maxQueueDepth || (this.queuedBytes + payloadBytes) > this.maxQueueBytes) {
      console.warn(`[Backpressure] Client ${this.id} exceeded limits (Depth: ${this.queue.length}, Bytes: ${this.queuedBytes}). Marking for snapshot resync.`);
      this.queue = [];
      this.queuedBytes = 0;
      this.needsResync = true;
      this.metrics.resyncCount += 1;

      // When the socket write buffer clears, send a fresh full document snapshot
      this.drainQueue();
      return false;
    }

    // 4. Add to client outbound queue
    this.queue.push({
      message: messageObj,
      raw: rawSerialized,
      rawBytes: payloadBytes,
      type: messageObj.type,
      deliveryClass,
      isFinal: Boolean(messageObj.isFinal),
      enqueuedAt: Date.now(),
    });
    this.queuedBytes += payloadBytes;

    this.drainQueue();
    return true;
  }

  /**
   * Non-blocking sender loop. Pops and transmits messages asynchronously.
   * Backpressure on slow clients is handled without blocking fast clients.
   */
  drainQueue() {
    if (this.isSending || this.isClosed || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Handle snapshot resynchronization when client falls too far behind
    if (this.needsResync) {
      if (this.ws.bufferedAmount === 0) {
        this.needsResync = false;
        if (typeof this.onResyncNeeded === 'function') {
          this.onResyncNeeded(this);
        }
      } else {
        setTimeout(() => this.drainQueue(), 20);
      }
      return;
    }

    if (this.queue.length === 0) {
      return;
    }

    // Check socket buffer backpressure: if socket buffer is full, wait for it to drain
    if (this.ws.bufferedAmount && this.ws.bufferedAmount > this.highWatermarkBytes) {
      setTimeout(() => this.drainQueue(), 10);
      return;
    }

    const item = this.queue.shift();
    this.queuedBytes = Math.max(0, this.queuedBytes - item.rawBytes);
    this.isSending = true;
    const sendStartTime = Date.now();

    try {
      this.ws.send(item.raw, (err) => {
        this.isSending = false;
        this.metrics.lastSendLatencyMs = Math.max(0, Date.now() - sendStartTime);

        if (err) {
          console.error(`[ClientSession] Error transmitting to ${this.id}:`, err);
        } else {
          this.metrics.sentMessages += 1;
          this.metrics.sentBytes += item.rawBytes;
        }

        // Continue draining remaining items
        if (!this.isClosed && (this.queue.length > 0 || this.needsResync)) {
          setImmediate(() => this.drainQueue());
        }
      });
    } catch (err) {
      this.isSending = false;
      console.error(`[ClientSession] Send exception for ${this.id}:`, err);
    }
  }

  getStats() {
    return {
      id: this.id,
      role: this.role,
      queueDepth: this.queue.length,
      queuedBytes: this.queuedBytes,
      bufferedAmount: this.ws.bufferedAmount || 0,
      sentMessages: this.metrics.sentMessages,
      sentBytes: this.metrics.sentBytes,
      coalescedCount: this.metrics.coalescedCount,
      droppedEphemeral: this.metrics.droppedEphemeral,
      resyncCount: this.metrics.resyncCount,
      sendLatencyMs: this.metrics.lastSendLatencyMs,
      needsResync: this.needsResync,
    };
  }

  close() {
    this.isClosed = true;
    this.queue = [];
    this.queuedBytes = 0;
  }
}
