import React, { useRef, useEffect, useState } from 'react';
import {
  Video as VideoIcon,
  Maximize2,
  Minimize2,
  RefreshCw,
  Volume2,
  VolumeX,
  User,
} from 'lucide-react';

export function FullVideoView({
  stream = null,
  isLive = true,
  isFullscreen = false,
  isPublisher = false,
  onToggleFullscreen,
  onRequestKeyframe,
  isMuted = false,
  volume = 1.0,
  onVolumeChange,
  onToggleMute,
  rotation = 0,
}) {
  const videoRef = useRef(null);
  const [isAutoplayBlocked, setIsAutoplayBlocked] = useState(false);
  const [resolutionText, setResolutionText] = useState('720p HD');

  const isRotatedSideways = rotation % 180 !== 0;
  const rotationStyle = rotation
    ? {
        transform: `rotate(${rotation}deg)${isRotatedSideways ? ' scale(0.65)' : ''}`,
        transformOrigin: 'center center',
        transition: 'transform 0.2s ease',
      }
    : undefined;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPublisher) {
      // Broadcaster video must always be muted locally to prevent audio echo / feedback loop
      video.muted = true;
    } else {
      video.muted = isMuted;
      video.volume = isMuted ? 0 : volume;
    }

    if (stream) {
      if (video.srcObject !== stream) {
        video.srcObject = stream;
      }

      const updateResolution = () => {
        if (video.videoWidth && video.videoHeight) {
          setResolutionText(`${video.videoWidth}×${video.videoHeight}`);
        }
      };

      video.addEventListener('loadedmetadata', updateResolution);
      video.addEventListener('resize', updateResolution);

      video
        .play()
        .then(() => {
          if (!isPublisher) {
            setIsAutoplayBlocked(false);
          }
        })
        .catch((err) => {
          if (!isPublisher && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
            setIsAutoplayBlocked(true);
            video.muted = true;
            video.play().catch(() => {});
          }
        });

      return () => {
        video.removeEventListener('loadedmetadata', updateResolution);
        video.removeEventListener('resize', updateResolution);
      };
    } else {
      video.srcObject = null;
    }
  }, [stream, isMuted, volume, isPublisher]);

  const handleUnblockAudio = () => {
    if (isPublisher) return;
    const video = videoRef.current;
    if (video) {
      video.muted = isMuted;
      video.volume = isMuted ? 0 : volume;
      video
        .play()
        .then(() => {
          setIsAutoplayBlocked(false);
        })
        .catch(() => {});
    }
  };

  const hasVideoTrack = stream && stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].readyState === 'live';

  return (
    <main className={`canvas-viewport-wrapper stream-video-stage ${isFullscreen ? 'stream-fullscreen-viewport' : ''}`}>
      <div className="full-video-outer-container">
        <div className="full-video-viewport-box">
          {/* Header bar on top of the stage */}
          <div className="full-video-header-bar">
            <div className="full-video-title-group">
              <span className={`status-dot ${isLive ? 'live' : 'offline'}`} />
              <VideoIcon size={14} className="text-emerald-400" />
              <span className="full-video-title">Presenter Video</span>
              {isLive ? (
                <span className="media-tag live">LIVE</span>
              ) : (
                <span className="media-tag connecting">CONNECTING</span>
              )}
              <span className="full-video-res-badge">{resolutionText}</span>
            </div>

            <div className="full-video-actions-group">
              {!isPublisher && onToggleMute && (
                <button
                  type="button"
                  onClick={onToggleMute}
                  className={`screen-tool-btn ${isMuted ? 'muted' : ''}`}
                  title={isMuted ? 'Unmute Audio' : 'Mute Audio'}
                >
                  {isMuted ? <VolumeX size={13} className="text-rose-400" /> : <Volume2 size={13} className="text-emerald-400" />}
                  <span>{isMuted ? 'Muted' : 'Audio'}</span>
                </button>
              )}

              {!isPublisher && onVolumeChange && !isMuted && (
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={(e) => onVolumeChange(Number(e.target.value))}
                  className="volume-slider stage-volume-slider"
                  title={`Volume: ${Math.round(volume * 100)}%`}
                  aria-label="Volume Slider"
                />
              )}

              {onRequestKeyframe && (
                <button
                  type="button"
                  onClick={onRequestKeyframe}
                  className="screen-tool-btn"
                  title="Refresh Video (Request Keyframe)"
                  aria-label="Refresh Video"
                >
                  <RefreshCw size={13} />
                  <span>Refresh</span>
                </button>
              )}

              {onToggleFullscreen && (
                <button
                  type="button"
                  onClick={onToggleFullscreen}
                  className="screen-tool-btn icon-only"
                  title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
                  aria-label="Toggle Fullscreen"
                >
                  {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>
              )}
            </div>
          </div>

          {/* Main Video Viewport */}
          <div className="full-video-wrapper">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              webkit-playsinline="true"
              x5-playsinline="true"
              muted={isPublisher || isMuted}
              style={rotationStyle}
              className={`full-video-element ${!hasVideoTrack ? 'video-invisible' : ''}`}
            />

            {/* Offline / Waiting Placeholder */}
            {!hasVideoTrack && (
              <div className="full-video-placeholder">
                <div className="video-placeholder-avatar">
                  <User size={48} className="text-slate-500 animate-pulse" />
                </div>
                <h3 className="placeholder-heading">Camera Feed Off</h3>
                <p className="placeholder-subtext">
                  The presenter has their camera turned off or the video feed is connecting via WebRTC SFU.
                </p>
              </div>
            )}

            {/* Audio autoplay policy unblock banner (Subscriber only) */}
            {!isPublisher && isAutoplayBlocked && (
              <button
                type="button"
                onClick={handleUnblockAudio}
                className="autoplay-unblock-banner"
                title="Tap to unmute presenter audio"
              >
                <Volume2 size={14} className="text-emerald-400 animate-pulse" />
                <span>Tap to Unmute Audio</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}