import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PenTool,
  Radio,
  Sparkles,
  ArrowRight,
  Shield,
  Users,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Video,
  Monitor,
  Tv,
} from 'lucide-react';

export function generateRoomId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars[Math.floor(Math.random() * chars.length)];
  }
  return `room-${rand}`;
}

export function LobbyPage() {
  const navigate = useNavigate();
  const [roomIdInput, setRoomIdInput] = useState('');
  const [sanitizedId, setSanitizedId] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [roomStatus, setRoomStatus] = useState(null); // { inUse, viewersCount, elementCount }
  const [errorText, setErrorText] = useState('');

  // Generate an initial suggested room ID
  const [suggestedRoomId] = useState(() => generateRoomId());

  // Handle room ID text input with alphanumeric + hyphen sanitization
  const handleInputChange = (e) => {
    const raw = e.target.value;
    // Allow alphanumeric and hyphens, convert to lowercase
    const clean = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
    setRoomIdInput(raw);
    setSanitizedId(clean);
  };

  // Debounced room status check
  useEffect(() => {
    if (!sanitizedId || sanitizedId.trim().length === 0) {
      setRoomStatus(null);
      setIsChecking(false);
      setErrorText('');
      return;
    }

    let isMounted = true;
    setIsChecking(true);
    setErrorText('');

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/room/${encodeURIComponent(sanitizedId)}/status`);
        if (!res.ok) {
          throw new Error(`Server returned ${res.status}`);
        }
        const data = await res.json();
        if (isMounted) {
          setRoomStatus(data);
          setIsChecking(false);
        }
      } catch (err) {
        if (isMounted) {
          console.warn('[Lobby] Failed to check room status:', err);
          // Fallback: Assume available if network query fails
          setRoomStatus({ inUse: false, viewersCount: 0 });
          setIsChecking(false);
        }
      }
    }, 350);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [sanitizedId]);

  // Action: Launch instant new studio room
  const handleCreateNewStudio = useCallback(() => {
    const newRoomId = generateRoomId();
    navigate(`/write/${newRoomId}`);
  }, [navigate]);

  // Action: Enter room as Broadcaster / Presenter
  const handleStartBroadcasting = useCallback(() => {
    const targetRoom = sanitizedId || suggestedRoomId;
    if (!targetRoom) {
      setErrorText('Please enter a valid room ID');
      return;
    }
    navigate(`/write/${targetRoom}`);
  }, [sanitizedId, suggestedRoomId, navigate]);

  // Action: Enter room as Viewer
  const handleJoinStream = useCallback(() => {
    const targetRoom = sanitizedId || suggestedRoomId;
    if (!targetRoom) {
      setErrorText('Please enter a valid room ID');
      return;
    }
    navigate(`/stream/${targetRoom}`);
  }, [sanitizedId, suggestedRoomId, navigate]);

  return (
    <div className="lobby-container">
      {/* Background ambient lighting */}
      <div className="lobby-glow glow-1" />
      <div className="lobby-glow glow-2" />

      {/* Main Content Card */}
      <div className="lobby-card">
        {/* Brand Header */}
        <div className="lobby-header">
          <div className="lobby-brand-badge">
            <span className="brand-dot-pulse" />
            <span className="brand-name">ExcaliStream</span>
            <span className="version-pill">v2.0 Multi-Room</span>
          </div>
          <h1 className="lobby-title">Ultra-Low Latency Live Studio</h1>
          <p className="lobby-subtitle">
            Zero-delay whiteboard streaming, WebRTC screenshare, and high-resolution video sharing across isolated rooms.
          </p>
        </div>

        {/* Quick Action: Create New Room */}
        <div className="lobby-quick-start-box">
          <div className="quick-start-info">
            <div className="quick-start-icon">
              <Sparkles size={20} className="text-amber-400" />
            </div>
            <div>
              <h3 className="quick-start-title">Start a New Studio Room</h3>
              <p className="quick-start-desc">
                Instantly create a fresh room with a unique random ID and begin broadcasting.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCreateNewStudio}
            className="btn-create-studio"
          >
            <PenTool size={16} />
            <span>Create Studio</span>
            <ArrowRight size={16} />
          </button>
        </div>

        <div className="lobby-divider">
          <span>OR ENTER A ROOM ID</span>
        </div>

        {/* Room ID Form & Status Check */}
        <div className="lobby-form-section">
          <label htmlFor="roomIdInput" className="form-label">
            <span>Room Code / Name</span>
            <span className="form-sublabel">Alphanumeric (e.g. <code>{suggestedRoomId}</code>)</span>
          </label>

          <div className="input-group">
            <input
              id="roomIdInput"
              type="text"
              value={roomIdInput}
              onChange={handleInputChange}
              placeholder={`e.g. ${suggestedRoomId}`}
              autoComplete="off"
              spellCheck="false"
              className="room-input"
            />
            {isChecking ? (
              <div className="input-status-icon">
                <Loader2 size={18} className="animate-spin text-slate-400" />
              </div>
            ) : sanitizedId ? (
              <button
                type="button"
                onClick={() => {
                  setRoomIdInput('');
                  setSanitizedId('');
                  setRoomStatus(null);
                }}
                className="input-clear-btn"
                title="Clear input"
              >
                ✕
              </button>
            ) : null}
          </div>

          {errorText && <div className="lobby-error-text">{errorText}</div>}

          {/* Room Status Indicator */}
          {sanitizedId && roomStatus && (
            <div className={`room-status-badge ${roomStatus.inUse ? 'status-in-use' : 'status-available'}`}>
              {roomStatus.inUse ? (
                <>
                  <div className="status-dot dot-live" />
                  <span className="status-text">
                    <strong>Broadcaster Live</strong> ({roomStatus.viewersCount} viewer{roomStatus.viewersCount === 1 ? '' : 's'})
                  </span>
                  <span className="status-hint">Viewer stream available</span>
                </>
              ) : (
                <>
                  <div className="status-dot dot-available" />
                  <span className="status-text">
                    <strong>Room Available</strong> — Ready to broadcast or view
                  </span>
                </>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="lobby-actions-grid">
            {/* Broadcaster Button */}
            <button
              type="button"
              onClick={handleStartBroadcasting}
              disabled={Boolean(roomStatus?.inUse)}
              className={`action-btn btn-broadcast ${roomStatus?.inUse ? 'btn-disabled' : ''}`}
              title={
                roomStatus?.inUse
                  ? 'A broadcaster is already active in this room (1 write window max).'
                  : 'Start broadcasting to this room as presenter'
              }
            >
              <div className="btn-icon-wrapper">
                <PenTool size={18} />
              </div>
              <div className="btn-text-block">
                <span className="btn-title">
                  {roomStatus?.inUse ? 'Broadcaster Active' : 'Start Broadcasting'}
                </span>
                <span className="btn-subtitle">
                  {roomStatus?.inUse ? 'Write limit reached' : 'Whiteboard, Screen & Video'}
                </span>
              </div>
            </button>

            {/* Viewer Button */}
            <button
              type="button"
              onClick={handleJoinStream}
              className={`action-btn btn-stream ${roomStatus?.inUse ? 'btn-stream-highlight' : ''}`}
              title="Watch stream in this room (unlimited viewers)"
            >
              <div className="btn-icon-wrapper">
                <Radio size={18} />
              </div>
              <div className="btn-text-block">
                <span className="btn-title">Watch Stream</span>
                <span className="btn-subtitle">
                  {roomStatus?.inUse ? `${roomStatus.viewersCount} watching live` : 'View broadcast'}
                </span>
              </div>
            </button>
          </div>

          {/* WebRTC SFU Live Telemetry Dashboard Quick Link */}
          <div style={{ marginTop: '16px', textAlign: 'center' }}>
            <a
              href="/sfu-dashboard"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                color: '#38bdf8',
                textDecoration: 'none',
                background: 'rgba(56, 189, 248, 0.08)',
                padding: '6px 14px',
                borderRadius: '9999px',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                transition: 'all 0.15s ease',
              }}
              title="Inspect WebRTC SFU active rooms, publishers, subscribers, and frame counts"
            >
              <span>📊 WebRTC SFU Telemetry Dashboard</span>
            </a>
          </div>
        </div>

        {/* Feature Highlights Footer */}
        <div className="lobby-features-row">
          <div className="feature-item">
            <Tv size={15} className="feature-icon" />
            <span>16:9 Locked Canvas</span>
          </div>
          <div className="feature-item">
            <Monitor size={15} className="feature-icon" />
            <span>WebRTC SFU Screen Share</span>
          </div>
          <div className="feature-item">
            <Video size={15} className="feature-icon" />
            <span>720p HD Presenter Video</span>
          </div>
          <div className="feature-item">
            <Shield size={15} className="feature-icon" />
            <span>1-Writer Lock & Isolations</span>
          </div>
        </div>
      </div>
    </div>
  );
}
