# ExcaliStream: Fixed-Ratio JSON Whiteboard Streaming App

A high-performance real-time JSON whiteboard streaming application built with **React**, **@excalidraw/excalidraw**, and a **Node.js WebSocket streaming engine**.

---

## 🚀 Key Features & Architectural Design

### 1. Fixed X-Y Ratio (16:9)
- Both the **Broadcaster (Write)** canvas and the **Stream Receiver (/stream)** canvas share a strictly locked **16:9 aspect ratio** container (`1600 × 900 px` logical coordinate bounds).
- Eliminates distortion, scaling inconsistencies, and viewport mismatch between presenter and audience.

### 2. Zoom-In ONLY on Initial X-Y Pixels
- **Locked Minimum Zoom:** Zoom level is strictly clamped to $\ge 1.0$ (100% initial full canvas). Viewers and broadcasters cannot zoom out into empty void.
- **Zoom-In Feature:** Users can zoom in ($1.0 \times \to 5.0 \times$) using trackpad/wheel or HUD buttons (`Zoom In +`, `150%`, `200%`, `300%`) to inspect and draw fine details within the initial bounds.
- **Pan Clamping:** When zoomed in, camera panning is clamped to stay within the $1600 \times 900$ coordinate boundary.

### 3. Dual-Frequency Streaming Pipeline
The app strictly decouples local drawing from network transmission:

| Pipeline Stage | Frequency / Setting | Behavior |
| :--- | :--- | :--- |
| **On-Screen Drawing** | Native Display (60 / 120 Hz) | Instant local GPU rendering via browser input pipeline. Never waits for network. |
| **Network Streaming** | **16 ms** (Starting value) / **33 ms** (Relaxed) | Batches updates during active strokes to avoid socket flooding. |
| **Stroke Completion** | **Immediately (0 ms delay)** | Flushes final smoothed stroke polygon the instant pointer is released. |
| **Full-Document Autosave** | **Every 1–5 seconds** (Default: 3s) | Transmits full document checkpoint for sync integrity & room recovery. |
| **Rendering** | Locally & Independently | Viewers render JSON elements via Excalidraw diffing without flicker. |

### 5. High-Performance One-to-Many Streaming Pipeline
- **Single Ingestion Pipeline (`RoomState.js`)**: Parses each drawing update once, validates it, updates canonical room document state, and generates an incremental patch delta serialized once for all recipients.
- **Incremental Element Updates**: Only changed Excalidraw elements are transmitted over the wire (instead of the entire scene array), reducing network egress bandwidth by **95%**.
- **Per-Client Outbound Queues (`ClientSession.js`)**: Every viewer has an independent bounded queue and non-blocking sender loop. A slow client never blocks fast clients (zero head-of-line blocking).
- **Backpressure & Coalescing**: When a client falls behind, superseded intermediate updates for the same element are coalesced in-place. If queue limits are exceeded, stale queue items are safely dropped and a clean full document snapshot is scheduled, avoiding data corruption.
- **Separate Delivery Classes**: Reliable delivery for document elements; best-effort delivery for ephemeral data (e.g. cursor positions).
- **Observability**: Live metrics endpoint at `/api/stats` and `/api/room/:roomId` measuring CPU%, memory, queue depths, message rates, and bandwidth.

---

## 🛠️ Running the Application

### Development (Hot Reloading + Dev Server):
```bash
npm run dev
```
Starts:
- WebSocket backend server on `http://localhost:3001` (`ws://localhost:3001/ws`)
- Vite dev server on `http://localhost:5173`

### Production Server:
```bash
npm run build
npm run server
```
Access the application directly on `http://localhost:3001` or `/stream` on `http://localhost:3001/stream`.

### Automated Test Suite:
```bash
# Invariant and architectural tests (Ordering, Backpressure, Reconnection, Snapshot Resync)
npm test

# Load benchmark (1, 5, 10, 25, 50 viewers continuous load simulation)
npm run test:benchmark
```
