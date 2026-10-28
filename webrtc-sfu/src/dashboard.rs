use std::time::Instant;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SfuStatusResponse {
    pub server_time: String,
    pub uptime_seconds: u64,
    pub active_rooms: usize,
    pub active_publishers: usize,
    pub active_subscribers: usize,
    pub metrics: SfuMetricsSnapshot,
    pub config: SfuConfigSnapshot,
    pub rooms: Vec<RoomSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SfuMetricsSnapshot {
    pub audio_frames_forwarded: u64,
    pub video_frames_forwarded: u64,
    pub keyframe_requests: u64,
    pub udp_packets_received: u64,
    pub errors: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SfuConfigSnapshot {
    pub signaling_port: u16,
    pub udp_port: u16,
    pub public_ip: String,
    pub lan_ip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub room_id: String,
    pub publisher: Option<PeerSnapshot>,
    pub subscribers: Vec<PeerSnapshot>,
    pub subscribers_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerSnapshot {
    pub peer_id: String,
    pub role: String,
    pub remote_addr: Option<String>,
    pub is_connected: bool,
    pub ice_state: String,
    pub ws_connected: bool,
    pub audio_mid: Option<String>,
    pub video_mid: Option<String>,
    pub screen_mid: Option<String>,
    pub stats: PeerStatsSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerStatsSnapshot {
    pub packets_in: u64,
    pub bytes_in: u64,
    pub packets_out: u64,
    pub bytes_out: u64,
    pub audio_frames_in: u64,
    pub video_frames_in: u64,
    pub screen_frames_in: u64,
    pub audio_frames_out: u64,
    pub video_frames_out: u64,
    pub screen_frames_out: u64,
    pub keyframe_requests: u64,
    pub last_activity_secs_ago: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct PeerStats {
    pub packets_in: u64,
    pub bytes_in: u64,
    pub packets_out: u64,
    pub bytes_out: u64,
    pub audio_frames_in: u64,
    pub video_frames_in: u64,
    pub screen_frames_in: u64,
    pub audio_frames_out: u64,
    pub video_frames_out: u64,
    pub screen_frames_out: u64,
    pub keyframe_requests: u64,
    pub last_packet_time: Option<Instant>,
    pub last_frame_time: Option<Instant>,
}

impl PeerStats {
    pub fn snapshot(&self, now: Instant) -> PeerStatsSnapshot {
        let last_time = self.last_packet_time.max(self.last_frame_time);
        let last_activity_secs_ago = last_time.map(|t| (now.duration_since(t).as_millis() as f64) / 1000.0);

        PeerStatsSnapshot {
            packets_in: self.packets_in,
            bytes_in: self.bytes_in,
            packets_out: self.packets_out,
            bytes_out: self.bytes_out,
            audio_frames_in: self.audio_frames_in,
            video_frames_in: self.video_frames_in,
            screen_frames_in: self.screen_frames_in,
            audio_frames_out: self.audio_frames_out,
            video_frames_out: self.video_frames_out,
            screen_frames_out: self.screen_frames_out,
            keyframe_requests: self.keyframe_requests,
            last_activity_secs_ago,
        }
    }
}

/// Generates the self-contained, real-time HTML/CSS/JS dashboard
pub fn render_dashboard_html() -> String {
    r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebRTC SFU Telemetry Dashboard</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f2937;
      --card-hover: #1e293b;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #38bdf8;
      --primary-dim: rgba(56, 189, 248, 0.15);
      --success: #34d399;
      --success-dim: rgba(52, 211, 153, 0.15);
      --warning: #fbbf24;
      --warning-dim: rgba(251, 191, 36, 0.15);
      --danger: #f87171;
      --danger-dim: rgba(248, 113, 113, 0.15);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .header-left h1 {
      font-size: 24px;
      font-weight: 700;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header-left p {
      color: var(--text-muted);
      font-size: 14px;
      margin-top: 4px;
    }
    .status-badge-live {
      background: var(--success-dim);
      color: var(--success);
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 9999px;
      border: 1px solid rgba(52, 211, 153, 0.3);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .btn {
      background: #1f2937;
      color: #ffffff;
      border: 1px solid #374151;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .btn:hover { background: #374151; }
    .btn-primary { background: #0284c7; border-color: #0369a1; }
    .btn-primary:hover { background: #0369a1; }
    .search-input {
      background: #1f2937;
      border: 1px solid #374151;
      color: #ffffff;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      width: 220px;
      outline: none;
    }
    .search-input:focus { border-color: var(--primary); }
    .metrics-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .metric-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }
    .metric-val {
      font-size: 22px;
      font-weight: 700;
      color: #ffffff;
    }
    .metric-sub {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .room-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 20px;
    }
    .room-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      overflow: hidden;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    .room-header {
      background: #1e293b;
      padding: 12px 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--card-border);
    }
    .room-title {
      font-size: 16px;
      font-weight: 600;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .room-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
    }
    .badge-active { background: var(--success-dim); color: var(--success); border: 1px solid rgba(52, 211, 153, 0.3); }
    .badge-idle { background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3); }
    .room-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .stream-link-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #0284c7;
      color: #ffffff;
      border: 1px solid #0369a1;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .stream-link-btn:hover {
      background: #0369a1;
      color: #ffffff;
      box-shadow: 0 2px 4px rgba(2, 132, 199, 0.4);
    }
    .write-link-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #1f2937;
      color: #e5e7eb;
      border: 1px solid #374151;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .write-link-btn:hover {
      background: #374151;
      color: #ffffff;
    }
    .room-body {
      padding: 18px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }
    @media (max-width: 900px) {
      .room-body { grid-template-columns: 1fr; }
    }
    .section-title {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .pub-box {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 14px;
    }
    .sub-box {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 14px;
    }
    .peer-row {
      display: grid;
      grid-template-columns: 130px 1fr;
      font-size: 12px;
      padding: 4px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .peer-label { color: var(--text-muted); }
    .peer-val { color: #f1f5f9; font-weight: 500; font-family: monospace; }
    .pill {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    .pill-green { background: var(--success-dim); color: var(--success); }
    .pill-yellow { background: var(--warning-dim); color: var(--warning); }
    .pill-red { background: var(--danger-dim); color: var(--danger); }
    .pill-blue { background: var(--primary-dim); color: var(--primary); }
    .sub-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 8px;
    }
    .sub-table th, .sub-table td {
      padding: 6px 8px;
      text-align: left;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .sub-table th {
      color: var(--text-muted);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
    }
    .sub-table td { font-family: monospace; }
    .alert-box {
      margin-top: 10px;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .alert-warning {
      background: var(--warning-dim);
      color: #fde047;
      border: 1px solid rgba(251, 191, 36, 0.3);
    }
    .empty-state {
      text-align: center;
      padding: 48px;
      background: var(--card-bg);
      border: 1px dashed var(--card-border);
      border-radius: 10px;
      color: var(--text-muted);
    }
    .empty-state h3 { color: #ffffff; font-size: 18px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>
        <span>WebRTC SFU Room & Peer Dashboard</span>
        <span class="status-badge-live" id="sfu-state-badge">SFU Online</span>
      </h1>
      <p>Direct real-time telemetry from Rust WebRTC SFU engine</p>
    </div>
    <div class="controls">
      <input type="text" id="filter-input" class="search-input" placeholder="Filter room or peer ID...">
      <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); cursor: pointer;">
        <input type="checkbox" id="auto-refresh" checked> Auto-refresh (2s)
      </label>
      <button id="refresh-btn" class="btn btn-primary">Refresh</button>
    </div>
  </div>

  <div class="metrics-bar" id="metrics-bar">
    <div class="metric-card">
      <div class="metric-label">Active Rooms</div>
      <div class="metric-val" id="metric-rooms">-</div>
      <div class="metric-sub" id="metric-rooms-sub">Total active rooms</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Publishers</div>
      <div class="metric-val" id="metric-pubs" style="color: var(--primary);">-</div>
      <div class="metric-sub">Active broadcasters</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Subscribers</div>
      <div class="metric-val" id="metric-subs" style="color: var(--success);">-</div>
      <div class="metric-sub">Connected viewers</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">UDP Packets In</div>
      <div class="metric-val" id="metric-udp">-</div>
      <div class="metric-sub">Total UDP media recv</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Video Frames</div>
      <div class="metric-val" id="metric-vframes">-</div>
      <div class="metric-sub">Forwarded to viewers</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">SFU Uptime</div>
      <div class="metric-val" id="metric-uptime">-</div>
      <div class="metric-sub" id="metric-ports">-</div>
    </div>
  </div>

  <div class="room-grid" id="rooms-container">
    <div class="empty-state">
      <h3>Loading WebRTC SFU state...</h3>
      <p>Fetching active rooms directly from SFU engine...</p>
    </div>
  </div>

  <script>
    let filterQuery = '';
    const autoRefreshCheckbox = document.getElementById('auto-refresh');
    const refreshBtn = document.getElementById('refresh-btn');
    const filterInput = document.getElementById('filter-input');

    filterInput.addEventListener('input', (e) => {
      filterQuery = e.target.value.toLowerCase().trim();
      renderRooms();
    });

    refreshBtn.addEventListener('click', fetchSFUData);

    let latestData = null;

    async function fetchSFUData() {
      // Determine base URL: try direct relative /api/rooms or fallback
      const candidates = ['/api/rooms', '/sfu/api/rooms', '/rooms'];
      let res = null;
      for (const url of candidates) {
        try {
          const r = await fetch(url);
          if (r.ok) {
            res = await r.json();
            break;
          }
        } catch (e) {}
      }

      if (!res) {
        document.getElementById('sfu-state-badge').textContent = 'SFU Offline';
        document.getElementById('sfu-state-badge').className = 'pill pill-red';
        return;
      }

      document.getElementById('sfu-state-badge').textContent = 'SFU Online';
      document.getElementById('sfu-state-badge').className = 'status-badge-live';

      latestData = res;
      renderMetrics(res);
      renderRooms();
    }

    function formatBytes(bytes) {
      if (!bytes || bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
    }

    function formatUptime(seconds) {
      if (!seconds) return '0s';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return `${h}h ${m}m ${s}s`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    }

    function renderMetrics(data) {
      document.getElementById('metric-rooms').textContent = data.activeRooms || (data.rooms ? data.rooms.length : 0);
      document.getElementById('metric-pubs').textContent = data.activePublishers || 0;
      document.getElementById('metric-subs').textContent = data.activeSubscribers || 0;
      document.getElementById('metric-udp').textContent = Number(data.metrics?.udpPacketsReceived || 0).toLocaleString();
      document.getElementById('metric-vframes').textContent = Number(data.metrics?.videoFramesForwarded || 0).toLocaleString();
      document.getElementById('metric-uptime').textContent = formatUptime(data.uptimeSeconds || 0);

      const lan = data.config?.lanIp ? ` | LAN: ${data.config.lanIp}` : '';
      document.getElementById('metric-ports').textContent = `UDP: ${data.config?.udpPort || 40000}${lan}`;
    }

    function getStreamUrl(roomId) {
      if (window.location.port === '3088') {
        const proto = window.location.protocol === 'http:' ? 'https:' : window.location.protocol;
        return `${proto}//${window.location.hostname}:5173/stream/${roomId}`;
      }
      return `${window.location.origin}/stream/${roomId}`;
    }

    function getWriteUrl(roomId) {
      if (window.location.port === '3088') {
        const proto = window.location.protocol === 'http:' ? 'https:' : window.location.protocol;
        return `${proto}//${window.location.hostname}:5173/write/${roomId}`;
      }
      return `${window.location.origin}/write/${roomId}`;
    }

    function renderRooms() {
      if (!latestData || !latestData.rooms) return;
      const container = document.getElementById('rooms-container');

      let filteredRooms = latestData.rooms;
      if (filterQuery) {
        filteredRooms = filteredRooms.filter(r => {
          const matchRoom = r.roomId.toLowerCase().includes(filterQuery);
          const matchPub = r.publisher?.peerId?.toLowerCase().includes(filterQuery);
          const matchSub = r.subscribers?.some(s => s.peerId.toLowerCase().includes(filterQuery));
          return matchRoom || matchPub || matchSub;
        });
      }

      if (filteredRooms.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <h3>No Active Rooms Found</h3>
            <p>${filterQuery ? `No rooms match search query "${filterQuery}".` : 'No publishers or subscribers currently connected to the SFU.'}</p>
          </div>
        `;
        return;
      }

      let html = '';
      for (const room of filteredRooms) {
        const hasPub = !!room.publisher;
        const subCount = room.subscribers?.length || 0;
        const streamUrl = getStreamUrl(room.roomId);
        const writeUrl = getWriteUrl(room.roomId);

        const statusBadge = hasPub
          ? `<span class="room-badge badge-active">● Active (${subCount} Viewers)</span>`
          : `<span class="room-badge badge-idle">○ Idle (${subCount} Viewers)</span>`;

        let pubContent = '';
        if (hasPub) {
          const p = room.publisher;
          const iceClass = (p.iceState === 'Connected' || p.iceState === 'Completed') ? 'pill-green' : (p.iceState === 'Checking' ? 'pill-yellow' : 'pill-red');
          const connClass = p.isConnected ? 'pill-green' : 'pill-yellow';
          const wsClass = p.wsConnected ? 'pill-green' : 'pill-red';

          const hasZeroVideoWarning = p.isConnected && (p.stats?.videoFramesIn === 0);

          pubContent = `
            <div class="peer-row"><span class="peer-label">Stream Link:</span><a href="${streamUrl}" target="_blank" rel="noopener noreferrer" style="color: var(--primary); text-decoration: underline; font-family: monospace; display: inline-flex; align-items: center; gap: 4px;"><span>/stream/${room.roomId}</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a></div>
            <div class="peer-row"><span class="peer-label">Peer ID:</span><span class="peer-val">${p.peerId}</span></div>
            <div class="peer-row"><span class="peer-label">Remote Address:</span><span class="peer-val">${p.remoteAddr || 'Awaiting UDP packet'}</span></div>
            <div class="peer-row"><span class="peer-label">ICE State:</span><span><span class="pill ${iceClass}">${p.iceState}</span></span></div>
            <div class="peer-row"><span class="peer-label">Peer Connection:</span><span><span class="pill ${connClass}">${p.isConnected ? 'Connected' : 'Connecting'}</span></span></div>
            <div class="peer-row"><span class="peer-label">Signaling WS:</span><span><span class="pill ${wsClass}">${p.wsConnected ? 'Active' : 'Dropped'}</span></span></div>
            <div class="peer-row"><span class="peer-label">Negotiated MIDs:</span><span class="peer-val">A: ${p.audioMid || '-'} | V: ${p.videoMid || '-'} | S: ${p.screenMid || '-'}</span></div>
            <div class="peer-row"><span class="peer-label">Audio Frames In:</span><span class="peer-val">${Number(p.stats?.audioFramesIn || 0).toLocaleString()}</span></div>
            <div class="peer-row"><span class="peer-label">Video Frames In:</span><span class="peer-val" style="color: ${hasZeroVideoWarning ? 'var(--warning)' : '#ffffff'};">${Number(p.stats?.videoFramesIn || 0).toLocaleString()}</span></div>
            <div class="peer-row"><span class="peer-label">Screen Frames In:</span><span class="peer-val">${Number(p.stats?.screenFramesIn || 0).toLocaleString()}</span></div>
            <div class="peer-row"><span class="peer-label">Packets / Bytes:</span><span class="peer-val">${Number(p.stats?.packetsIn || 0).toLocaleString()} pkts (${formatBytes(p.stats?.bytesIn || 0)})</span></div>
            ${p.stats?.lastActivitySecsAgo !== undefined && p.stats?.lastActivitySecsAgo !== null ? `<div class="peer-row"><span class="peer-label">Last Ingress:</span><span class="peer-val">${p.stats.lastActivitySecsAgo.toFixed(1)}s ago</span></div>` : ''}

            ${hasZeroVideoWarning ? `
              <div class="alert-box alert-warning">
                <span>⚠️ Broadcaster WebRTC is Connected, but <strong>0 video frames</strong> received. Check camera track or permissions.</span>
              </div>
            ` : ''}
          `;
        } else {
          pubContent = `
            <div style="color: var(--text-muted); font-size: 13px; padding: 12px 0;">
              No active publisher broadcasting in this room.
              <div style="margin-top: 8px;">
                <a href="${streamUrl}" target="_blank" rel="noopener noreferrer" style="color: var(--primary); text-decoration: underline; font-size: 12px;">Watch stream page (/stream/${room.roomId}) ↗</a>
              </div>
            </div>
          `;
        }

        let subContent = '';
        if (subCount > 0) {
          subContent = `
            <table class="sub-table">
              <thead>
                <tr>
                  <th>Peer ID</th>
                  <th>Remote IP</th>
                  <th>ICE</th>
                  <th>V-Frames</th>
                  <th>A-Frames</th>
                  <th>PLI</th>
                </tr>
              </thead>
              <tbody>
                ${room.subscribers.map(s => {
                  const sIceClass = (s.iceState === 'Connected' || s.iceState === 'Completed') ? 'pill-green' : 'pill-yellow';
                  return `
                    <tr>
                      <td style="color: var(--primary);">${s.peerId}</td>
                      <td>${s.remoteAddr || 'Connecting'}</td>
                      <td><span class="pill ${sIceClass}">${s.iceState}</span></td>
                      <td>${Number(s.stats?.videoFramesOut || 0).toLocaleString()}</td>
                      <td>${Number(s.stats?.audioFramesOut || 0).toLocaleString()}</td>
                      <td>${s.stats?.keyframeRequests || 0}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          `;
        } else {
          subContent = `<div style="color: var(--text-muted); font-size: 13px; padding: 12px 0;">0 subscribers connected to this room.</div>`;
        }

        html += `
          <div class="room-card">
            <div class="room-header">
              <div class="room-title">
                <span>Room: ${room.roomId}</span>
                ${statusBadge}
              </div>
              <div class="room-actions">
                <a href="${streamUrl}" target="_blank" rel="noopener noreferrer" class="stream-link-btn" title="Open Viewer Stream in new tab">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  <span>Watch Stream (/stream/${room.roomId})</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </a>
                <a href="${writeUrl}" target="_blank" rel="noopener noreferrer" class="write-link-btn" title="Open Broadcaster Studio">
                  <span>Studio (/write)</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </a>
              </div>
            </div>
            <div class="room-body">
              <div class="pub-box">
                <div class="section-title">
                  <span>Broadcaster (Publisher)</span>
                  ${hasPub ? `<span class="pill pill-blue">Active</span>` : `<span class="pill pill-red">None</span>`}
                </div>
                ${pubContent}
              </div>
              <div class="sub-box">
                <div class="section-title">
                  <span>Subscribers (${subCount})</span>
                </div>
                ${subContent}
              </div>
            </div>
          </div>
        `;
      }

      container.innerHTML = html;
    }

    // Auto refresh interval
    setInterval(() => {
      if (autoRefreshCheckbox.checked) {
        fetchSFUData();
      }
    }, 2000);

    // Initial fetch
    fetchSFUData();
  </script>
</body>
</html>"##.to_string()
}
