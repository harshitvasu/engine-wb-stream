# ExcaliStream: Fixed-Ratio JSON Whiteboard + Custom Rust WebRTC SFU

A high-performance real-time collaborative streaming platform featuring:
- **Excalidraw Whiteboard Engine:** 16:9 fixed-ratio JSON canvas streaming with single-ingestion delta updates and per-client outbound queues.
- **Custom Rust WebRTC SFU (`webrtc-sfu/`):** Self-hosted Selective Forwarding Unit built on **`str0m`** and **Tokio** providing low-latency live microphone audio (Opus) and camera thumbnail video (VP8) streaming directly from broadcaster to all stream viewers without third-party media cloud dependencies.

---

## 🚀 Key Features & Architectural Design

### 1. Fixed X-Y Ratio (16:9)
- Both the **Broadcaster (Write)** canvas and the **Stream Receiver (/stream)** canvas share a strictly locked **16:9 aspect ratio** container (`1600 × 900 px` logical coordinate bounds).
- Eliminates distortion, scaling inconsistencies, and viewport mismatch between presenter and audience.

### 2. Dual-Frequency JSON Streaming Pipeline
- **On-Screen Drawing:** Instant local GPU rendering via browser input pipeline (never blocked by network).
- **Network Streaming:** Batches updates during active strokes (configurable 16ms / 33ms) to prevent socket flooding.
- **Stroke Completion:** Flushes final smoothed stroke polygon the instant pointer is released (0ms delay).
- **Single Ingestion Pipeline (`RoomState.js`):** Incremental element delta updates reduce egress bandwidth by 95%.
- **Per-Client Queues (`ClientSession.js`):** Independent queues with in-place coalescing ensure slow viewers never block fast viewers.

### 3. Custom Rust WebRTC Selective Forwarding Unit (SFU)
- **Standalone Rust Service (`webrtc-sfu/`):** Built with `str0m 0.24` (Sans-I/O WebRTC stack) and `tokio`.
- **Media Engine & Multi-Track Forwarding:**
  - Ingests encoded **Opus** audio, **VP8** full-resolution camera video, and **VP8** full-resolution screen share video directly from the broadcaster.
  - Forwarded without decoding or re-encoding across independent DTLS-SRTP sessions to all connected subscribers in the room.
  - Generates RTCP Picture Loss Indication (PLI) feedback to request immediate IDR keyframes for video and screen tracks when viewers join or switch views.
- **Screen Sharing (`ScreenShareView.jsx`):**
  - Broadcaster can share screen/window/tab (`getDisplayMedia`) at Full Resolution (1080p+ @ up to 60fps) over the WebRTC SFU.
  - Web Audio mixer captures and combines system/tab audio with presenter microphone speech into a single synchronized Opus audio stream.
  - Viewers experience high-clarity screen sharing with zero distortion, crisp typography, and full-screen expansion.
- **Full Resolution Video Sharing (`FullVideoView.jsx`):**
  - Unconstrained high-definition camera video (1080p / 720p HD) transmitted over WebRTC SFU for live speaker/webinar presentations.
  - Hardware-accelerated pixel-level rotation support (90°, 180°, 270°, 360°) preserved in high resolution.
- **Multi-Mode Stream Presentation & Switching:**
  - Broadcaster can switch presentation modes with one click: **Whiteboard**, **Screen Share**, or **Full Video**.
  - Room state synchronization notifies all viewers in real-time (`share_mode`).
  - Viewers automatically follow the presenter by default (`Follow Presenter`), or can independently toggle between Whiteboard, Screen Share, and Full Video views.
- **Live Video Thumbnail (`PublisherVideoThumbnail.jsx`):**
  - Displays presenter camera inside a floating, collapsible overlay during Whiteboard and Screen Share modes.
  - Broadcaster controls: Mute/Unmute microphone, Enable/Disable camera, Quick Screen Share toggle, Video Rotation.
  - Viewer controls: Mute/Unmute audio, volume slider, video refresh (keyframe request), and minimize/expand.
- **Dedicated Signaling Channel:** WebSocket signaling on port `3088` (proxied in development through Vite at `/rtc-ws`).

---

## 🌐 Networking & Deployment Considerations

### Required Network Ports
| Port | Protocol | Purpose | Service |
| :--- | :--- | :--- | :--- |
| **5173** | TCP | Vite Frontend Development Server | Local Dev |
| **3001** | TCP | Node.js REST API & JSON Whiteboard Stream (`/ws`) | Node Server |
| **3088** | TCP | WebRTC SFU Signaling Server (JSON over WebSocket) | Rust SFU |
| **40000** | UDP | WebRTC Media Transport (SRTP / RTCP / STUN) | Rust SFU |

### Browser HTTPS & Secure Context Requirements
Modern web browsers strictly enforce that `navigator.mediaDevices.getUserMedia()` is only available in **Secure Contexts**:
- `http://localhost` and `http://127.0.0.1` are treated as secure contexts by Chrome, Firefox, Safari, and Edge.
- When hosting or testing across a **Local Network (LAN)** or public internet domain, the frontend **must be served over HTTPS** (e.g. using a reverse proxy such as Nginx or Caddy with TLS certificates, or `mkcert` for local LAN testing) for browser camera and microphone permissions to function.

### NAT, ICE Candidates, and STUN/TURN
- **Local Development:** The SFU automatically advertises `127.0.0.1:40000` as its host ICE candidate.
- **LAN / Public Server:** Set the environment variable `SFU_PUBLIC_IP=<YOUR_IP>` so the SFU advertises an IP reachable by external peers.
- **Symmetric NATs / Strict Enterprise Firewalls:** If peers are behind strict or symmetric NATs where direct UDP hole punching fails, a standard WebRTC TURN relay (such as `coturn`) should be configured in the client's `RTCPeerConnection` ICE servers.

---

## 🛠️ Running the Application

### 1. Start All Services Together (Dev Mode)
```bash
npm run dev:all
```
This concurrently starts:
1. **Node.js Server:** `http://localhost:3001` (Whiteboard JSON stream at `ws://localhost:3001/ws`)
2. **Rust WebRTC SFU:** Signaling at `ws://localhost:3088`, Media at `UDP 40000`
3. **Vite Frontend Dev Server:** `http://localhost:5173`

### 2. Or Start Services Individually
```bash
# Terminal 1: Node.js Backend Server
npm run server

# Terminal 2: Rust WebRTC SFU Server
npm run sfu:dev
# (or release mode: npm run sfu)

# Terminal 3: React Vite Client
npm run client
```

### 3. Production Build & Server
```bash
npm run build
npm run sfu &
npm run server
```
Access the application on `http://localhost:3001` (Broadcaster) or `http://localhost:3001/stream` (Stream Viewer).

---

## 🧪 Automated Test Suite

Run all validation tests across the entire application:

```bash
# 1. Run Complete Test Suite (Node.js Whiteboard + Rust SFU E2E WebRTC + Integration)
npm run test:all

# 2. Run Rust WebRTC SFU E2E Media & Multi-Subscriber Tests (Audio + Video Forwarding)
npm run test:sfu

# 3. Run Whiteboard Invariant & Backpressure Tests (Node server must be running)
npm test

# 4. Run System Signaling Integration Test (Both Node server and Rust SFU running)
npm run test:integration
```
