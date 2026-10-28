import { useState, useEffect, useRef, useCallback } from 'react';
import { getSfuWebSocketUrl } from '../config/constants';

/**
 * Draws the camera feed into a canvas sized to (cw x ch) rotated by `rotationDeg`.
 * Supports full resolution (1080p / 720p) with clean slate letterboxing for portrait rotations.
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
 * - Capture local microphone audio (Opus) and camera at Full Resolution (1080p / 720p HD)
 * - Capture screen sharing via getDisplayMedia at Full Resolution (1080p / 4k @ 30-60fps) with optional screen audio
 * - Real-time pixel-level video rotation pipeline (90, 180, 270, 360 deg) at native video resolution
 * - Establish an encrypted WebRTC PeerConnection with the custom Rust SFU broadcasting Audio, Video, and Screen tracks
 * - Web Audio mixer combining microphone speech and screen audio
 * - Toggle microphone muting, camera enable/disable, and screen sharing
 * - Gracefully handle device permission denials, browser screen share bar events, and reconnections
 */
export function useWebRTCStreamer({
  roomId = 'default',
  autoStart = true,
  activeShareMode = 'whiteboard',
  onScreenShareEnded,
} = {}) {
  const [localStream, setLocalStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isVideoDisabled, setIsVideoDisabled] = useState(false);
  const [isRtcConnected, setIsRtcConnected] = useState(false);
  const [rtcError, setRtcError] = useState(null);
  const [permissionError, setPermissionError] = useState(null);
  const [videoRotation, setVideoRotationState] = useState(0);

  const activeShareModeRef = useRef(activeShareMode);
  activeShareModeRef.current = activeShareMode;

  const onScreenShareEndedRef = useRef(onScreenShareEnded);
  onScreenShareEndedRef.current = onScreenShareEnded;

  const pcRef = useRef(null);
  const wsRef = useRef(null);
  const peerIdRef = useRef(`pub-${Math.random().toString(36).substring(2, 9)}`);
  const rawStreamRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const rawVideoRef = useRef(null);
  const canvasRef = useRef(null);
  const rotationRef = useRef(0);
  const renderLoopActiveRef = useRef(false);

  // Transceiver Send Senders
  const audioSenderRef = useRef(null);
  const videoSenderRef = useRef(null);
  const screenSenderRef = useRef(null);

  // Web Audio Mixer for Mic + Screen Audio
  const audioCtxRef = useRef(null);
  const audioDestRef = useRef(null);
  const micSourceNodeRef = useRef(null);
  const screenAudioSourceNodeRef = useRef(null);
  const screenAudioTrackRef = useRef(null);

  const reconnectTimeoutRef = useRef(null);
  const pingIntervalRef = useRef(null);
  const isAcquiringMediaRef = useRef(false);
  const isCleaningUpRef = useRef(false);

  // Dynamically update WebRTC video encoding bitrate:
  // - In 'video' mode: full 720p HD @ 2.2 Mbps
  // - In non-video mode (whiteboard or screen): throttle bitrate to ~300 kbps for thumbnail (saves bandwidth)
  const updateVideoEncodingParameters = useCallback(async (mode) => {
    const sender = videoSenderRef.current;
    const pc = pcRef.current;
    if (!sender || !sender.track || !pc || pc.connectionState !== 'connected') return;
    try {
      const params = sender.getParameters();
      if (!params || !params.encodings || params.encodings.length === 0) return;

      if (mode === 'video') {
        params.encodings[0].maxBitrate = 2200000; // 2.2 Mbps
        params.encodings[0].maxFramerate = 30;
      } else {
        params.encodings[0].maxBitrate = 300000; // 300 kbps
        params.encodings[0].maxFramerate = 24;
      }
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[WebRTC Streamer] Video parameters update warning:', err);
    }
  }, []);

  // Update video encoding whenever presentation share mode changes
  useEffect(() => {
    updateVideoEncodingParameters(activeShareMode);
  }, [activeShareMode, updateVideoEncodingParameters]);

  // Rotate broadcast video stream by given angle (90, 180, 270, 360...)
  const setVideoRotation = useCallback((angleOrUpdater) => {
    setVideoRotationState((prev) => {
      const next = typeof angleOrUpdater === 'function' ? angleOrUpdater(prev) : angleOrUpdater;
      rotationRef.current = next;
      return next;
    });
  }, []);

  // Web Audio Mixer setup: mixes mic audio and screen audio into single clean Opus track
  const setupAudioMixer = useCallback(() => {
    try {
      const micTrack = rawStreamRef.current?.getAudioTracks()?.[0];
      const screenAudioTrack = screenAudioTrackRef.current;

      if (!audioCtxRef.current) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          audioCtxRef.current = new AudioContextClass();
          audioDestRef.current = audioCtxRef.current.createMediaStreamDestination();
        }
      }

      const ctx = audioCtxRef.current;
      const dest = audioDestRef.current;
      if (!ctx || !dest) return;

      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      // Reconnect mic source
      if (micSourceNodeRef.current) {
        try { micSourceNodeRef.current.disconnect(); } catch {}
        micSourceNodeRef.current = null;
      }
      if (micTrack) {
        const micStream = new MediaStream([micTrack]);
        micSourceNodeRef.current = ctx.createMediaStreamSource(micStream);
        micSourceNodeRef.current.connect(dest);
      }

      // Reconnect screen audio source
      if (screenAudioSourceNodeRef.current) {
        try { screenAudioSourceNodeRef.current.disconnect(); } catch {}
        screenAudioSourceNodeRef.current = null;
      }
      if (screenAudioTrack && screenAudioTrack.readyState === 'live') {
        const scrStream = new MediaStream([screenAudioTrack]);
        screenAudioSourceNodeRef.current = ctx.createMediaStreamSource(scrStream);
        screenAudioSourceNodeRef.current.connect(dest);
      }

      const mixedAudioTrack = dest.stream.getAudioTracks()[0];
      if (mixedAudioTrack && audioSenderRef.current) {
        audioSenderRef.current.replaceTrack(mixedAudioTrack);
      }
    } catch (err) {
      console.warn('[WebRTC Publisher] Audio mixer setup warning:', err);
    }
  }, []);

  // 1. Acquire local camera and microphone stream at Full Resolution directly from user devices
  const acquireMedia = useCallback(async () => {
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

      // Strategy 1: Standard 720p HD camera video + noise-cancelled audio
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            width: { ideal: 1280, max: 1280, min: 640 },
            height: { ideal: 720, max: 720, min: 360 },
            frameRate: { ideal: 30, max: 30 },
          },
        });
      } catch (err1) {
        console.warn('[WebRTC Publisher] 720p media failed, trying basic 720p/360p fallback:', err1);
        try {
          // Strategy 2: 720p / 360p fallback
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: {
              width: { ideal: 1280, min: 480 },
              height: { ideal: 720, min: 270 },
              frameRate: { ideal: 30 },
            },
          });
        } catch (err2) {
          console.warn('[WebRTC Publisher] 720p fallback failed, trying basic unconstrained {audio: true, video: true}:', err2);
          try {
            // Strategy 3: Basic unconstrained audio and video
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          } catch (err3) {
            console.warn('[WebRTC Publisher] Combined media failed, trying audio-only fallback:', err3);
            try {
              // Strategy 4: Audio only
              stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
              setIsVideoDisabled(true);
            } catch (err4) {
              console.warn('[WebRTC Publisher] Audio fallback failed, trying video-only fallback:', err4);
              // Strategy 5: Video only
              stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
              setIsMicMuted(true);
            }
          }
        }
      }

      if (!stream) {
        throw new Error('No camera or microphone device available.');
      }

      rawStreamRef.current = stream;

      const rawVideoTracks = stream.getVideoTracks();
      if (rawVideoTracks.length > 0) {
        // Setup hidden video element to decode raw camera frames
        const rawVideo = document.createElement('video');
        rawVideo.muted = true;
        rawVideo.playsInline = true;
        rawVideo.autoplay = true;
        rawVideo.srcObject = stream;
        rawVideoRef.current = rawVideo;

        // Dynamic resolution canvas capped at 720p HD (1280x720) for rotation and encoding
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d', { alpha: false });
        canvasRef.current = canvas;

        try {
          await rawVideo.play();
        } catch (e) {
          console.warn('[WebRTC Publisher] Hidden raw video auto-play caught:', e);
        }

        // Adjust canvas resolution once video metadata is loaded, capped strictly at 720p
        const updateCanvasDims = () => {
          if (rawVideo.videoWidth && rawVideo.videoHeight) {
            const maxW = 1280;
            const maxH = 720;
            const scale = Math.min(maxW / rawVideo.videoWidth, maxH / rawVideo.videoHeight, 1.0);
            canvas.width = Math.round(rawVideo.videoWidth * scale);
            canvas.height = Math.round(rawVideo.videoHeight * scale);
          }
        };
        rawVideo.addEventListener('loadedmetadata', updateCanvasDims);
        updateCanvasDims();

        // Active frame capture loop: renders camera frames with rotationRef.current applied at full resolution
        renderLoopActiveRef.current = true;
        const scheduleFrame = () => {
          if (!renderLoopActiveRef.current) return;
          const cw = canvas.width || 1280;
          const ch = canvas.height || 720;
          if ('requestVideoFrameCallback' in rawVideo) {
            rawVideo.requestVideoFrameCallback(() => {
              if (renderLoopActiveRef.current) {
                drawRotatedVideoFrame(ctx, rawVideo, cw, ch, rotationRef.current);
                scheduleFrame();
              }
            });
          } else {
            requestAnimationFrame(() => {
              if (renderLoopActiveRef.current) {
                drawRotatedVideoFrame(ctx, rawVideo, cw, ch, rotationRef.current);
                scheduleFrame();
              }
            });
          }
        };
        scheduleFrame();

        // Capture live high-definition video stream from canvas at 30fps with physically rotated pixels
        const canvasStream = canvas.captureStream(30);
        const processedVideoTrack = canvasStream.getVideoTracks()[0];

        // Combine microphone audio with processed high-def video track for WebRTC broadcast
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

  // 2. Screen Sharing Pipeline
  const stopScreenShare = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => {
        try { t.stop(); } catch {}
      });
      screenStreamRef.current = null;
    }
    setScreenStream(null);
    setIsScreenSharing(false);

    if (screenSenderRef.current) {
      try {
        screenSenderRef.current.replaceTrack(null);
      } catch (e) {
        console.warn('[WebRTC Publisher] Failed to clear screen sender track:', e);
      }
    }

    if (screenAudioTrackRef.current) {
      try { screenAudioTrackRef.current.stop(); } catch {}
      screenAudioTrackRef.current = null;
      setupAudioMixer();
    }

    // Notify SFU of track update
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'tracks_update',
          peerId: peerIdRef.current,
          audio: true,
          video: !isVideoDisabled,
          screen: false,
        })
      );
    }
  }, [isVideoDisabled, setupAudioMixer]);

  const startScreenShare = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      const err = 'Screen sharing is not supported in this browser.';
      console.error(err);
      setRtcError(err);
      return null;
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 60 },
        },
        audio: true, // Request system/tab audio if available
      });

      screenStreamRef.current = displayStream;
      setScreenStream(displayStream);
      setIsScreenSharing(true);

      const screenVideoTrack = displayStream.getVideoTracks()[0];
      if (screenVideoTrack) {
        // Native browser "Stop sharing" button clicked by user
        screenVideoTrack.onended = () => {
          console.log('[WebRTC Publisher] Native screen sharing stopped by user');
          stopScreenShare();
          onScreenShareEndedRef.current?.();
        };

        // Attach screen track to existing WebRTC screen sender without full renegotiation
        if (screenSenderRef.current) {
          await screenSenderRef.current.replaceTrack(screenVideoTrack);
          console.log('[WebRTC Publisher] Screen video track attached to WebRTC sender');
        }
      }

      // Check if screen audio was captured
      const screenAudioTracks = displayStream.getAudioTracks();
      if (screenAudioTracks.length > 0) {
        screenAudioTrackRef.current = screenAudioTracks[0];
        screenAudioTracks[0].onended = () => {
          screenAudioTrackRef.current = null;
          setupAudioMixer();
        };
        setupAudioMixer();
      }

      // Notify SFU of active screen track
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'tracks_update',
            peerId: peerIdRef.current,
            audio: true,
            video: !isVideoDisabled,
            screen: true,
          })
        );
      }

      return displayStream;
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        console.log('[WebRTC Publisher] Screen share selection cancelled by user');
      } else {
        console.error('[WebRTC Publisher] Failed to acquire display media:', err);
        setRtcError(err.message || 'Failed to start screen share');
      }
      return null;
    }
  }, [isVideoDisabled, setupAudioMixer, stopScreenShare]);

  const toggleScreenShare = useCallback(() => {
    if (isScreenSharing) {
      stopScreenShare();
    } else {
      startScreenShare();
    }
  }, [isScreenSharing, startScreenShare, stopScreenShare]);

  // 3. Connect to Rust SFU and negotiate WebRTC session
  const connectSFU = useCallback((stream) => {
    if (!stream || isCleaningUpRef.current) return;

    // Fresh peerId for each new RTCPeerConnection to ensure a fresh session and handshake in SFU
    peerIdRef.current = `pub-${Math.random().toString(36).substring(2, 9)}`;

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
      console.log(`[WebRTC Publisher] Connected to SFU signaling at ${sfuUrl} (${peerIdRef.current})`);
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
            break;

          case 'joined': {
            console.log(`[WebRTC Publisher] Registered in room ${roomId} as Publisher (${peerIdRef.current})`);
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

      // 1. Audio Transceiver
      const audioTrack = stream.getAudioTracks()[0] || null;
      const audioTransceiver = pc.addTransceiver(audioTrack || 'audio', {
        direction: 'sendonly',
        streams: [stream],
      });
      audioSenderRef.current = audioTransceiver.sender;

      // 2. Camera Video Transceiver (Standard sendonly transceiver)
      const videoTrack = stream.getVideoTracks()[0] || null;
      const cameraTransceiver = pc.addTransceiver(videoTrack || 'video', {
        direction: 'sendonly',
        streams: [stream],
      });
      videoSenderRef.current = cameraTransceiver.sender;

      // 3. Screen Video Transceiver (Full Resolution)
      const currentScreenTrack = screenStreamRef.current?.getVideoTracks()?.[0] || null;
      const screenTransceiver = pc.addTransceiver(currentScreenTrack || 'video', {
        direction: 'sendonly',
      });
      screenSenderRef.current = screenTransceiver.sender;
      if (currentScreenTrack) {
        try {
          await screenTransceiver.sender.replaceTrack(currentScreenTrack);
        } catch {}
      }

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
          updateVideoEncodingParameters(activeShareModeRef.current);
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
            tracks: {
              audioMid: audioTransceiver.mid || '0',
              videoMid: cameraTransceiver.mid || '1',
              screenMid: screenTransceiver.mid || '2',
            },
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
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
      if (screenAudioTrackRef.current) {
        screenAudioTrackRef.current.stop();
        screenAudioTrackRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
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

  // Stop device tracks on page unload
  useEffect(() => {
    const handleUnload = () => {
      renderLoopActiveRef.current = false;
      if (rawStreamRef.current) {
        rawStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
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
      if (audioSenderRef.current?.track) {
        audioSenderRef.current.track.enabled = !willBeMuted;
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
      if (videoSenderRef.current?.track) {
        videoSenderRef.current.track.enabled = !willBeDisabled;
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
    screenStream,
    isScreenSharing,
    startScreenShare,
    stopScreenShare,
    toggleScreenShare,
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