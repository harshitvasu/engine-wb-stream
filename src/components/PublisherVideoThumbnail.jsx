import React, { useRef, useEffect, useState } from 'react';
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  Volume2,
  VolumeX,
  Minimize2,
  Maximize2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  User,
} from 'lucide-react';

export function PublisherVideoThumbnail({
  stream = null,
  isPublisher = false,
  isConnected = false,
  isMicMuted = false,
  isVideoDisabled = false,
  hasVideoTrack = null,
  hasAudioTrack = null,
  rotation = 0,
  onRotate,
  onToggleMic,
  onToggleVideo,
  onRetryMedia,
  isAudioMuted = false,
  onToggleAudioMute,
  volume = 1.0,
  onVolumeChange,
  onRequestKeyframe,
  error = null,
}) {
  const videoRef = useRef(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isAutoplayBlocked, setIsAutoplayBlocked] = useState(false);
  const [internalRotation, setInternalRotation] = useState(0);
  const [, setTrackState] = useState(0);

  const currentRotation = rotation !== undefined ? rotation : internalRotation;
  const handleRotate = onRotate || (() => setInternalRotation((prev) => prev + 90));

  // Re-render when tracks are added or removed on the stream
  useEffect(() => {
    if (!stream) return;
    const handleTracksChanged = () => {
      setTrackState((c) => c + 1);
      if (videoRef.current && videoRef.current.paused) {
        videoRef.current.play().catch(() => {});
      }
    };
    stream.addEventListener('addtrack', handleTracksChanged);
    stream.addEventListener('removetrack', handleTracksChanged);
    return () => {
      stream.removeEventListener('addtrack', handleTracksChanged);
      stream.removeEventListener('removetrack', handleTracksChanged);
    };
  }, [stream]);

  // Unified stream attachment and playback pipeline
  // Both audio and video are played synchronously through this single video element to guarantee lip-sync
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPublisher) {
      // Broadcaster video must always be muted locally to prevent audio feedback
      video.muted = true;
    } else {
      video.muted = isAudioMuted;
      video.volume = isAudioMuted ? 0 : volume;
    }

    if (stream) {
      if (video.srcObject !== stream) {
        video.srcObject = stream;
      }
      video
        .play()
        .then(() => {
          if (!isPublisher && !video.muted) {
            setIsAutoplayBlocked(false);
          }
        })
        .catch((err) => {
          if (!isPublisher && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
            console.warn('[WebRTC Audio/Video] Autoplay blocked by browser policy. Playing muted until tapped:', err);
            setIsAutoplayBlocked(true);
            video.muted = true;
            video.play().catch(() => {});
          } else {
            console.warn('[WebRTC Video] Video play caught:', err);
          }
        });
    } else {
      video.srcObject = null;
    }
  }, [stream, isPublisher]);

  // Handle subscriber volume and mute changes on the unified video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPublisher) {
      video.muted = true;
    } else {
      video.muted = isAudioMuted;
      video.volume = isAudioMuted ? 0 : volume;
      if (!isAudioMuted && video.paused) {
        video.play().catch(() => {
          setIsAutoplayBlocked(true);
        });
      }
    }
  }, [isPublisher, isAudioMuted, volume]);

  const handleUnblockAudio = () => {
    const video = videoRef.current;
    if (video) {
      video.muted = isAudioMuted;
      video.volume = isAudioMuted ? 0 : volume;
      video
        .play()
        .then(() => {
          setIsAutoplayBlocked(false);
        })
        .catch((err) => {
          console.warn('Manual audio unblock failed:', err);
        });
    }
  };

  const hasVideo =
    stream &&
    (hasVideoTrack !== null ? hasVideoTrack : stream.getVideoTracks().length > 0) &&
    !isVideoDisabled;

  return (
    <div
      className={`floating-media-card ${isMinimized ? 'minimized' : ''} ${
        isPublisher ? 'is-publisher' : 'is-subscriber'
      }`}
      aria-label={isPublisher ? 'Broadcaster Camera Preview' : 'Presenter Audio & Video Feed'}
    >
      {/* Header bar */}
      <div className="media-card-header">
        <div className="media-card-title-group">
          <span className={`status-dot ${isConnected ? 'live' : 'offline'}`} />
          <span className="media-card-title">
            {isPublisher ? 'Broadcaster Cam' : 'Presenter Cam'}
          </span>
          {isConnected ? (
            <span className="media-tag live">LIVE</span>
          ) : (
            <span className="media-tag connecting">CONNECTING</span>
          )}
        </div>

        <div className="media-card-actions">
          {/* Quick 90° clockwise video rotate button: Publisher ONLY */}
          {isPublisher && onRotate && (
            <button
              type="button"
              onClick={handleRotate}
              className="media-card-btn icon-only rotate-btn"
              title={`Rotate Video 90° (Current: ${currentRotation % 360}°)`}
              aria-label="Rotate Video 90 degrees"
            >
              <RotateCw size={11} />
            </button>
          )}

          {!isPublisher && onRequestKeyframe && (
            <button
              type="button"
              onClick={onRequestKeyframe}
              className="media-card-btn icon-only"
              title="Request Video Refresh (Keyframe)"
              aria-label="Refresh video stream"
            >
              <RefreshCw size={11} />
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsMinimized((prev) => !prev)}
            className="media-card-btn icon-only"
            title={isMinimized ? 'Expand Video' : 'Minimize Video'}
            aria-label={isMinimized ? 'Expand Video' : 'Minimize Video'}
          >
            {isMinimized ? <Maximize2 size={11} /> : <Minimize2 size={11} />}
          </button>
        </div>
      </div>

      {/* Main Video Viewport */}
      {!isMinimized && (
        <div className="media-card-body">
          <div className="video-viewport">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              webkit-playsinline="true"
              x5-playsinline="true"
              muted={isPublisher}
              className={`video-element ${!hasVideo ? 'video-invisible' : ''}`}
            />

            {/* Video Disabled / Offline Placeholder */}
            {!hasVideo && (
              <div className="video-placeholder">
                <div className="placeholder-avatar">
                  <User size={30} className="text-slate-400" />
                </div>
                <span className="placeholder-label">
                  {isVideoDisabled
                    ? 'Camera Off'
                    : isPublisher
                    ? 'Acquiring Camera...'
                    : !isConnected
                    ? 'Connecting SFU...'
                    : 'Audio Only'}
                </span>
              </div>
            )}

            {/* Autoplay blocked banner for subscribers (iOS Safari) */}
            {!isPublisher && isAutoplayBlocked && (
              <button
                type="button"
                onClick={handleUnblockAudio}
                className="autoplay-unblock-banner"
                title="Browser paused audio until clicked"
              >
                <Volume2 size={13} className="text-emerald-400 animate-pulse" />
                <span>Tap to Unmute Audio</span>
              </button>
            )}

            {/* In-viewport status badges */}
            <div className="video-overlay-badges">
              {isPublisher && (
                <span className="overlay-badge">
                  {isMicMuted ? (
                    <MicOff size={11} className="text-rose-400" />
                  ) : (
                    <Mic size={11} className="text-emerald-400" />
                  )}
                </span>
              )}
            </div>
          </div>

          {/* Controls Footer */}
          <div className="media-card-controls">
            {isPublisher ? (
              <>
                <button
                  type="button"
                  onClick={onToggleMic}
                  className={`ctrl-btn ${isMicMuted ? 'muted' : 'active'}`}
                  title={isMicMuted ? 'Unmute Microphone' : 'Mute Microphone'}
                >
                  {isMicMuted ? <MicOff size={13} /> : <Mic size={13} />}
                  <span>{isMicMuted ? 'Muted' : 'Mic On'}</span>
                </button>

                <button
                  type="button"
                  onClick={onToggleVideo}
                  className={`ctrl-btn ${isVideoDisabled ? 'off' : 'active'}`}
                  title={isVideoDisabled ? 'Turn Camera On' : 'Turn Camera Off'}
                >
                  {isVideoDisabled ? <VideoOff size={13} /> : <VideoIcon size={13} />}
                  <span>{isVideoDisabled ? 'Cam Off' : 'Cam On'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleRotate}
                  className="ctrl-btn rotate-btn"
                  title={`Rotate Broadcast Video 90° (Current: ${currentRotation}°)`}
                >
                  <RotateCw size={13} />
                  <span>
                    {currentRotation % 360 === 0 && currentRotation > 0
                      ? '360°'
                      : currentRotation % 360 === 0
                      ? 'Rotate'
                      : `${currentRotation % 360}°`}
                  </span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onToggleAudioMute}
                  className={`ctrl-btn ${isAudioMuted ? 'muted' : 'active'}`}
                  title={isAudioMuted ? 'Unmute Audio' : 'Mute Audio'}
                >
                  {isAudioMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  <span>{isAudioMuted ? 'Muted' : 'Audio'}</span>
                </button>

                {onVolumeChange && !isAudioMuted && (
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volume}
                    onChange={(e) => onVolumeChange(Number(e.target.value))}
                    className="volume-slider"
                    title={`Volume: ${Math.round(volume * 100)}%`}
                    aria-label="Volume Slider"
                  />
                )}
              </>
            )}
          </div>

          {/* Error and retry banner */}
          {error && (
            <div className="media-error-badge">
              <span>{error}</span>
              {isPublisher && onRetryMedia && (
                <button
                  type="button"
                  onClick={onRetryMedia}
                  className="error-retry-link"
                  title="Retry acquiring camera and microphone"
                >
                  <RotateCcw size={10} />
                  <span>Retry</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
