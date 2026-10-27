import { useState, useEffect, useRef, useCallback } from 'react';
import { getSfuWebSocketUrl } from '../config/constants';

/**
 * Draws the camera feed into a fixed 16:9 canvas (320x180) rotated by `rotationDeg`.
 * Guarantees aspect ratio preservation with clean slate letterboxing for portrait rotations.
 */
function drawRotatedVideoFrame(ctx, video, cw, ch, rotationDeg) {
  ctx.fillStyle = '#090d16';
  ctx.fillRect(0, 0, cw, ch);

  const vw = video.videoWidth || cw;
  const vh = video.videoHeight || ch;
  if (!vw || !vh || video.readyState < 2) return;

  const rot = ((rotationDeg % 360) + 360) % 360;

  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((rot * Math.PI) / 180);

  let destW, destH;
  if (rot === 90 || rot === 270) {
    // When rotated 90 or 270, source width aligns with canvas height, and source height with canvas width
    const scale = Math.min(cw / vh, ch / vw);
    destW = vw * scale;
    destH = vh * scale;
  } else {
    const scale = Math.min(cw / vw, ch / vh);
    destW = vw * scale;
    destH = vh * scale;
  }

  ctx.drawImage(video, -destW / 2, -destH / 2, destW, destH);
  ctx.restore();
}

/**
 * Custom hook for the Broadcaster / Publisher to:
 * - Capture local microphone audio (Opus) and camera thumbnail directly from local devices
 * - Real-time pixel-level video rotation pipeline (90, 180, 270, 360 deg) captured via canvas
 * - Display the local camera source directly (unstreamed, muted locally to prevent feedback)
 * - Establish an encrypted WebRTC PeerConnection with the custom Rust SFU to broadcast tracks
 * - Toggle microphone muting and camera enable/disable on active tracks and senders
 * - Gracefully handle device permission denials and reconnections
 */
export function useWebRTCStreamer({ roomId = 'default', autoStart = true } = {}) {
  const [localStream, setLocalStream] = useState(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isVideoDisabled, setIsVideoDisabled] = useState(false);
  const [isRtcConnected, setIsRtcConnected] = useState(false);
  const [rtcError, setRtcError] = useState(null);
  const [permissionError, setPermissionError] = useState(null);
  const [videoRotation, setVideoRotationState] = useState(0);

  const pcRef = useRef(null);
  const wsRef = useRef(null);
  const peerIdRef = useRef(`pub-${Math.random().toString(36).substring(2, 9)}`);
  const rawStreamRef = useRef(null);
  const localStreamRef = useRef(null);
  const rawVideoRef = useRef(null);
  const canvasRef = useRef(null);
  const rotationRef = useRef(0);
  const renderLoopActiveRef = useRef(false);

  const reconnectTimeoutRef = useRef(null);
  const pingIntervalRef = useRef(null);
  const isAcquiringMediaRef = useRef(false);
  const isCleaningUpRef = useRef(false);

  // Rotate broadcast video stream by given angle (90, 180, 270, 360...)
  const setVideoRotation = useCallback((angleOrUpdater) => {
    setVideoRotationState((prev) => {
      const next = typeof angleOrUpdater === 'function' ? angleOrUpdater(prev) : angleOrUpdater;
      rotationRef.current = next;
      return next;
    });
  }, []);

  // 1. Acquire local camera and microphone stream directly from user devices
  const acquireMedia = useCallback(async () => {
    // If a live stream already exists, reuse it rather than re-prompting devices
    if (localStreamRef.current) {
      const activeTracks = localStreamRef.current.getTracks().filter((t) => t.readyState === 'live');
      if (activeTracks.length > 0) {
        setLocalStream(localStreamRef.current);
        return localStreamRef.current;
      }
    }

    if (isAcquiringMediaRef.current) {
      return localStreamRef.current;
    }

    try {
      isAcquiringMediaRef.current = true;
      setPermissionError(null);
      setRtcError(null);

      let stream = null;

      // Strategy 1: Low-overhead thumbnail video constraints + noise-cancelled audio
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            width: { ideal: 320 },
            height: { ideal: 180 },
            frameRate: { ideal: 30, max: 30 },
          },
        });
      } catch (err1) {
        console.warn('[WebRTC Publisher] Constrained media failed, trying basic {audio: true, video: true}:', err1);
        try {
          // Strategy 2: Basic unconstrained audio and video
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        } catch (err2) {
          console.warn('[WebRTC Publisher] Combined media failed, trying audio-only fallback:', err2);
          try {
            // Strategy 3: Audio only
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            setIsVideoDisabled(true);
          } catch (err3) {
            console.warn('[WebRTC Publisher] Audio fallback failed, trying video-only fallback:', err3);
            // Strategy 4: Video only
            stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
            setIsMicMuted(true);
          }
        }
      }

      if (!stream) {
        throw new Error('No camera or microphone device available.');
      }

      rawStreamRef.current = stream;

      const rawVideoTracks = stream.getVideoTracks();
      if (rawVideoTracks.length > 0) {
        // Setup hidden video element to decode and drive raw camera frames
        const rawVideo = document.createElement('video');
        rawVideo.muted = true;
        rawVideo.playsInline = true;
        rawVideo.autoplay = true;
        rawVideo.srcObject = stream;
        rawVideoRef.current = rawVideo;

        // Setup hidden 2D canvas (fixed 320x180 16:9 standard thumbnail format)
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d', { alpha: false });
        canvasRef.current = canvas;

        try {
          await rawVideo.play();
        } catch (e) {
          console.warn('[WebRTC Publisher] Hidden raw video auto-play caught:', e);
        }

        // Active frame capture loop: renders camera frames with rotationRef.current applied to pixels
        renderLoopActiveRef.current = true;
        const scheduleFrame = () => {
          if (!renderLoopActiveRef.current) return;
          if ('requestVideoFrameCallback' in rawVideo) {
            rawVideo.requestVideoFrameCallback(() => {
              if (renderLoopActiveRef.current) {
                drawRotatedVideoFrame(ctx, rawVideo, 320, 180, rotationRef.current);
                scheduleFrame();
              }
            });
          } else {
            requestAnimationFrame(() => {
              if (renderLoopActiveRef.current) {
                drawRotatedVideoFrame(ctx, rawVideo, 320, 180, rotationRef.current);
                scheduleFrame();
              }
            });
          }
        };
        scheduleFrame();

        // Capture live video stream from canvas at 30fps with physically rotated pixels
        const canvasStream = canvas.captureStream(30);
        const processedVideoTrack = canvasStream.getVideoTracks()[0];

        // Combine microphone audio with processed rotated video track for WebRTC broadcast
        const broadcastStream = new MediaStream([
          ...stream.getAudioTracks(),
          processedVideoTrack,
        ]);
        localStreamRef.current = broadcastStream;
        setLocalStream(broadcastStream);
        return broadcastStream;
      } else {
        localStreamRef.current = stream;
        setLocalStream(stream);
        return stream;
      }
    } catch (err) {
      console.error('[WebRTC Publisher] Local device acquisition error:', err);
      setPermissionError(err.message || 'Media permission denied or device not found');
      return null;
    } finally {
      isAcquiringMediaRef.current = false;
    }
  }, []);

  // 2. Connect to Rust SFU and negotiate WebRTC session
  const connectSFU = useCallback((stream) => {
    if (!stream || isCleaningUpRef.current) return;

    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }

    const sfuUrl = getSfuWebSocketUrl();
    const ws = new WebSocket(sfuUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[WebRTC Publisher] Connected to SFU signaling at ${sfuUrl}`);
      ws.send(
        JSON.stringify({
          type: 'join',
          roomId,
          role: 'publisher',
          peerId: peerIdRef.current,
        })
      );

      // Heartbeat ping every 5 seconds to prevent mobile / Wi-Fi idle timeout
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = setInterval(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'ping' }));
        }
      }, 5000);
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'pong':
            // Heartbeat acknowledged by SFU
            break;

          case 'joined': {
            console.log(`[WebRTC Publisher] Registered in room ${roomId} as Publisher`);
            await createAndSendOffer();
            break;
          }

          case 'answer': {
            if (pcRef.current && msg.sdp) {
              console.log('[WebRTC Publisher] Received SDP answer from SFU');
              await pcRef.current.setRemoteDescription(
                new RTCSessionDescription({ type: 'answer', sdp: msg.sdp })
              );
            }
            break;
          }

          case 'candidate': {
            if (pcRef.current && msg.candidate?.candidate) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate));
            }
            break;
          }

          case 'error': {
            console.error('[WebRTC Publisher] SFU signaling error:', msg.message);
            setRtcError(msg.message);
            break;
          }
        }
      } catch (err) {
        console.error('[WebRTC Publisher] Error handling SFU signaling message:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('[WebRTC Publisher] SFU signaling WebSocket error:', err);
    };

    ws.onclose = () => {
      console.log('[WebRTC Publisher] SFU signaling WebSocket closed');
      clearInterval(pingIntervalRef.current);
      setIsRtcConnected(false);
      if (!isCleaningUpRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (localStreamRef.current && !isCleaningUpRef.current) {
            connectSFU(localStreamRef.current);
          }
        }, 3000);
      }
    };

    async function createAndSendOffer() {
      const pc = new RTCPeerConnection({
        bundlePolicy: 'max-bundle',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      pcRef.current = pc;

      // Add local media tracks to the peer connection
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Trickle ICE candidates to SFU
      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'candidate',
              peerId: peerIdRef.current,
              candidate: {
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex,
              },
            })
          );
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`[WebRTC Publisher] PeerConnection state: ${state}`);
        if (state === 'connected') {
          setIsRtcConnected(true);
          setRtcError(null);
        } else if (state === 'disconnected' || state === 'failed') {
          setIsRtcConnected(false);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log(`[WebRTC Publisher] ICE connection state: ${state}`);
        if (state === 'connected' || state === 'completed') {
          setIsRtcConnected(true);
        } else if (state === 'failed') {
          pc.restartIce();
        }
      };

      // Create offer with sendonly audio and video (never receive media loopback on WritePage)
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'offer',
            peerId: peerIdRef.current,
            sdp: offer.sdp,
          })
        );
      }
    }
  }, [roomId]);

  // Main lifecycle effect: initialize media and signaling on mount
  useEffect(() => {
    isCleaningUpRef.current = false;

    if (autoStart) {
      acquireMedia().then((stream) => {
        if (stream && !isCleaningUpRef.current) {
          connectSFU(stream);
        }
      });
    }

    return () => {
      isCleaningUpRef.current = true;
      renderLoopActiveRef.current = false;
      clearTimeout(reconnectTimeoutRef.current);
      clearInterval(pingIntervalRef.current);

      if (rawVideoRef.current) {
        rawVideoRef.current.srcObject = null;
        rawVideoRef.current = null;
      }
      if (rawStreamRef.current) {
        rawStreamRef.current.getTracks().forEach((t) => t.stop());
        rawStreamRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      canvasRef.current = null;

      if (pcRef.current) {
        try { pcRef.current.close(); } catch {}
        pcRef.current = null;
      }
      if (wsRef.current) {
        try {
          if (wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                type: 'leave',
                roomId,
                peerId: peerIdRef.current,
              })
            );
          }
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
    };
  }, [roomId, autoStart, acquireMedia, connectSFU]);

  // Stop device tracks on page unload or component unmount
  useEffect(() => {
    const handleUnload = () => {
      renderLoopActiveRef.current = false;
      if (rawStreamRef.current) {
        rawStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, []);

  // Toggle microphone audio track (mute / unmute)
  const toggleMic = useCallback(() => {
    setIsMicMuted((prevMuted) => {
      const willBeMuted = !prevMuted;
      if (rawStreamRef.current) {
        rawStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = !willBeMuted;
        });
      }
      const stream = localStreamRef.current;
      if (stream) {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !willBeMuted;
        });
      }
      if (pcRef.current) {
        pcRef.current.getSenders().forEach((s) => {
          if (s.track && s.track.kind === 'audio') {
            s.track.enabled = !willBeMuted;
          }
        });
      }
      return willBeMuted;
    });
  }, []);

  // Toggle camera video track (on / off)
  const toggleVideo = useCallback(() => {
    setIsVideoDisabled((prevDisabled) => {
      const willBeDisabled = !prevDisabled;
      if (rawStreamRef.current) {
        rawStreamRef.current.getVideoTracks().forEach((track) => {
          track.enabled = !willBeDisabled;
        });
      }
      const stream = localStreamRef.current;
      if (stream) {
        stream.getVideoTracks().forEach((track) => {
          track.enabled = !willBeDisabled;
        });
      }
      if (pcRef.current) {
        pcRef.current.getSenders().forEach((s) => {
          if (s.track && s.track.kind === 'video') {
            s.track.enabled = !willBeDisabled;
          }
        });
      }
      return willBeDisabled;
    });
  }, []);

  // Explicit retry media acquisition and reconnect
  const retryWebRTC = useCallback(async () => {
    renderLoopActiveRef.current = false;
    if (rawVideoRef.current) {
      rawVideoRef.current.srcObject = null;
      rawVideoRef.current = null;
    }
    if (rawStreamRef.current) {
      rawStreamRef.current.getTracks().forEach((t) => t.stop());
      rawStreamRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    canvasRef.current = null;

    const stream = await acquireMedia();
    if (stream) {
      connectSFU(stream);
    }
  }, [acquireMedia, connectSFU]);

  return {
    localStream,
    isMicMuted,
    isVideoDisabled,
    isRtcConnected,
    rtcError,
    permissionError,
    videoRotation,
    setVideoRotation,
    toggleMic,
    toggleVideo,
    retryWebRTC,
  };
}
