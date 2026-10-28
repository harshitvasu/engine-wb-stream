import React, { useRef, useEffect, useState } from 'react';
import {
  Monitor,
  Maximize2,
  Minimize2,
  RefreshCw,
  Volume2,
  WifiOff,
} from 'lucide-react';

export function ScreenShareView({
  stream = null,
  isLive = true,
  isFullscreen = false,
  isPublisher = false,
  onToggleFullscreen,
  onRequestKeyframe,
  isMuted = false,
  volume = 1.0,
}) {
  const videoRef = useRef(null);
  const [isAutoplayBlocked, setIsAutoplayBlocked] = useState(false);
  const [resolutionText, setResolutionText] = useState('1080p HD');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPublisher) {
      // Broadcaster screen preview must always be muted locally to prevent audio feedback
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
    <main className={`canvas-viewport-wrapper stream-screen-stage ${isFullscreen ? 'stream-fullscreen-viewport' : ''}`}>
      <div className="screen-share-outer-container">
        <div className="screen-share-viewport-box">
          {/* Header bar on top of the stage */}
          <div className="screen-share-header-bar">
            <div className="screen-share-title-group">
              <span className={`status-dot ${isLive ? 'live' : 'offline'}`} />
              <Monitor size={14} className="text-blue-400" />
              <span className="screen-share-title">Screen Share</span>
              {isLive ? (
                <span className="media-tag live">LIVE</span>
              ) : (
                <span className="media-tag connecting">CONNECTING</span>
              )}
              <span className="screen-share-res-badge">{resolutionText}</span>
            </div>

            <div className="screen-share-actions-group">
              {onRequestKeyframe && (
                <button
                  type="button"
                  onClick={onRequestKeyframe}
                  className="screen-tool-btn"
                  title="Refresh Screen Stream (Request Keyframe)"
                  aria-label="Refresh Screen"
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

          {/* Main Video Element */}
          <div className="screen-share-video-wrapper">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              webkit-playsinline="true"
              x5-playsinline="true"
              muted={isPublisher || isMuted}
              className={`screen-video-element ${!hasVideoTrack ? 'video-invisible' : ''}`}
            />

            {/* Offline / Waiting Placeholder */}
            {!hasVideoTrack && (
              <div className="screen-share-placeholder">
                <div className="screen-placeholder-icon">
                  <Monitor size={48} className="text-slate-500 animate-pulse" />
                </div>
                <h3 className="placeholder-heading">Waiting for Presenter's Screen</h3>
                <p className="placeholder-subtext">
                  The presenter has not started sharing their screen yet or the feed is connecting via WebRTC SFU.
                </p>
              </div>
            )}

            {/* Audio autoplay policy unblock banner (Subscriber only) */}
            {!isPublisher && isAutoplayBlocked && (
              <button
                type="button"
                onClick={handleUnblockAudio}
                className="autoplay-unblock-banner"
                title="Tap to unmute screen audio"
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