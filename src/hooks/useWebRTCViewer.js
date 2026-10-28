import { useState, useEffect, useRef, useCallback } from 'react';
import { getSfuWebSocketUrl } from '../config/constants';
import { logToServer } from '../utils/remoteLogger';

/**
 * Prioritizes H.264 video codec on an RTCRtpTransceiver.
 * iPad and Safari strictly require H.264 for hardware-accelerated video encoding and decoding.
 * Aligning codecs across broadcaster and subscribers prevents codec mismatch in the SFU router.
 */
function prioritizeH264(transceiver) {
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
  try {
    const kind = transceiver.receiver?.track?.kind || 'video';
    const capabilities =
      (typeof RTCRtpReceiver.getCapabilities === 'function' && RTCRtpReceiver.getCapabilities(kind)) ||
      (typeof RTCRtpSender.getCapabilities === 'function' && RTCRtpSender.getCapabilities(kind));
    if (!capabilities || !capabilities.codecs) return;

    const codecs = capabilities.codecs;
    const h264Codecs = codecs.filter((c) => c.mimeType && c.mimeType.toLowerCase() === 'video/h264');
    const otherCodecs = codecs.filter((c) => !c.mimeType || c.mimeType.toLowerCase() !== 'video/h264');
    if (h264Codecs.length > 0) {
      transceiver.setCodecPreferences([...h264Codecs, ...otherCodecs]);
    }
  } catch (err) {
    console.warn('[WebRTC Subscriber] prioritizeH264 error:', err);
  }
}

/**
 * Custom hook for Viewers / Subscribers to:
 * - Establish an encrypted WebRTC PeerConnection with the custom Rust SFU
 * - Receive live Opus audio, full resolution VP8 camera video, and full resolution VP8 screen share tracks
 * - Maintain periodic signaling heartbeats (5s ping) to prevent mobile Wi-Fi / Safari idle drops
 * - Resiliently handle signaling drops without interrupting live UDP media playback
 * - Request keyframes (PLI) for video and screen so decoding starts without delay
 * - Control audio mute, volume, and handle reconnects
 */
export function useWebRTCViewer({ roomId = 'default', autoStart = true } = {}) {
  const [remoteStream, setRemoteStream] = useState(null); // Combined/camera stream for backward compatibility
  const [cameraStream, setCameraStream] = useState(null); // Full-resolution Presenter Camera
  const [screenStream, setScreenStream] = useState(null); // Full-resolution Shared Screen
  const [isRtcConnected, setIsRtcConnected] = useState(false);
  const [hasAudioTrack, setHasAudioTrack] = useState(false);
  const [hasVideoTrack, setHasVideoTrack] = useState(false);
  const [hasScreenTrack, setHasScreenTrack] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [volume, setVolumeState] = useState(1.0);
  const [rtcError, setRtcError] = useState(null);

  const pcRef = useRef(null);
  const wsRef = useRef(null);
  const peerIdRef = useRef(`sub-${Math.random().toString(36).substring(2, 9)}`);

  const cameraTransceiverRef = useRef(null);
  const screenTransceiverRef = useRef(null);
  const cameraTransceiverMidRef = useRef(null);
  const screenTransceiverMidRef = useRef(null);

  const audioStreamRef = useRef(new MediaStream());
  const cameraStreamRef = useRef(new MediaStream());
  const screenStreamRef = useRef(new MediaStream());

  const reconnectTimeoutRef = useRef(null);
  const pingIntervalRef = useRef(null);
  const isCleaningUpRef = useRef(false);

  const requestKeyframe = useCallback((kind = 'all') => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'request_keyframe',
          peerId: peerIdRef.current,
          kind: typeof kind === 'string' ? kind : 'all',
        })
      );
    }
  }, []);

  const connectSFU = useCallback(() => {
    if (isCleaningUpRef.current) return;

    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    clearInterval(pingIntervalRef.current);

    const sfuUrl = getSfuWebSocketUrl();
    const ws = new WebSocket(sfuUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[WebRTC Subscriber] Connected to SFU at ${sfuUrl}`);
      ws.send(
        JSON.stringify({
          type: 'join',
          roomId,
          role: 'subscriber',
          peerId: peerIdRef.current,
        })
      );

      // Heartbeat ping every 5 seconds to prevent mobile Safari / Wi-Fi idle timeout
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
            logToServer('Subscriber-SFU', 'Joined room as Subscriber -> creating offer', { roomId });
            console.log(`[WebRTC Subscriber] Registered in room ${roomId}`);
            await createAndSendOffer();
            break;
          }

          case 'answer': {
            if (pcRef.current && msg.sdp) {
              logToServer('Subscriber-SFU', 'Received SDP answer from SFU');
              console.log('[WebRTC Subscriber] Received SDP answer from SFU');
              await pcRef.current.setRemoteDescription(
                new RTCSessionDescription({ type: 'answer', sdp: msg.sdp })
              );
              // Request keyframes so video and screen decoders lock onto IDR frames immediately
              requestKeyframe('all');
              setTimeout(() => requestKeyframe('all'), 800);
            }
            break;
          }

          case 'candidate': {
            if (pcRef.current && msg.candidate?.candidate) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate));
            }
            break;
          }

          case 'tracks_available': {
            logToServer('Subscriber-SFU', 'Tracks available notification from SFU', {
              audio: msg.audio,
              video: msg.video,
              screen: msg.screen,
            });
            console.log('[WebRTC Subscriber] Tracks available notification from SFU:', msg);
            if (typeof msg.audio === 'boolean') setHasAudioTrack(msg.audio);
            if (typeof msg.video === 'boolean') setHasVideoTrack(msg.video);
            if (typeof msg.screen === 'boolean') setHasScreenTrack(msg.screen);

            if (msg.video) {
              requestKeyframe('video');
              setTimeout(() => requestKeyframe('video'), 800);
            }
            if (msg.screen) {
              requestKeyframe('screen');
              setTimeout(() => requestKeyframe('screen'), 800);
            }
            break;
          }

          case 'peer_disconnected': {
            console.log('[WebRTC Subscriber] Publisher disconnected');
            setHasAudioTrack(false);
            setHasVideoTrack(false);
            setHasScreenTrack(false);
            break;
          }

          case 'error': {
            console.warn('[WebRTC Subscriber] SFU error:', msg.message);
            setRtcError(msg.message);
            break;
          }
        }
      } catch (err) {
        console.error('[WebRTC Subscriber] Error processing message:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('[WebRTC Subscriber] Signaling WebSocket error:', err);
    };

    ws.onclose = () => {
      console.log('[WebRTC Subscriber] Signaling WebSocket closed');
      clearInterval(pingIntervalRef.current);

      if (!isCleaningUpRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (!isCleaningUpRef.current) {
            const pc = pcRef.current;
            const isPeerActive = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected');
            if (isPeerActive) {
              reconnectSignalingOnly();
            } else {
              connectSFU();
            }
          }
        }, 2000);
      }
    };

    function reconnectSignalingOnly() {
      if (isCleaningUpRef.current) return;
      const sfuUrl = getSfuWebSocketUrl();
      const reconnectWs = new WebSocket(sfuUrl);
      wsRef.current = reconnectWs;

      reconnectWs.onopen = () => {
        console.log(`[WebRTC Subscriber] Re-attached signaling to SFU at ${sfuUrl}`);
        reconnectWs.send(
          JSON.stringify({
            type: 'join',
            roomId,
            role: 'subscriber',
            peerId: peerIdRef.current,
          })
        );
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = setInterval(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'ping' }));
          }
        }, 5000);
      };

      reconnectWs.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'tracks_available') {
            if (typeof msg.audio === 'boolean') setHasAudioTrack(msg.audio);
            if (typeof msg.video === 'boolean') setHasVideoTrack(msg.video);
            if (typeof msg.screen === 'boolean') setHasScreenTrack(msg.screen);
            if (msg.video) requestKeyframe('video');
            if (msg.screen) requestKeyframe('screen');
          } else if (msg.type === 'peer_disconnected') {
            setHasAudioTrack(false);
            setHasVideoTrack(false);
            setHasScreenTrack(false);
          }
        } catch {}
      };

      reconnectWs.onclose = () => {
        clearInterval(pingIntervalRef.current);
        if (!isCleaningUpRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = setTimeout(() => {
            if (!isCleaningUpRef.current) {
              const pc = pcRef.current;
              const isPeerActive = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected');
              if (isPeerActive) {
                reconnectSignalingOnly();
              } else {
                connectSFU();
              }
            }
          }, 3000);
        }
      };
    }

    async function createAndSendOffer() {
      const pc = new RTCPeerConnection({
        bundlePolicy: 'max-bundle',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      pcRef.current = pc;

      // 1. Audio Transceiver (recvonly)
      const audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });

      // 2. Camera Video Transceiver (recvonly) - Full Resolution Camera
      const cameraTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
      cameraTransceiverRef.current = cameraTransceiver;

      // 3. Screen Video Transceiver (recvonly) - Full Resolution Screen Sharing
      const screenTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
      screenTransceiverRef.current = screenTransceiver;

      pc.ontrack = (e) => {
        const kind = e.track.kind;
        const mid = e.transceiver?.mid;
        console.log(`[WebRTC Subscriber] Inbound track: kind=${kind}, mid=${mid}, id=${e.track.id}`);

        if (kind === 'audio') {
          audioStreamRef.current.getTracks().forEach((t) => {
            if (t.id !== e.track.id) audioStreamRef.current.removeTrack(t);
          });
          audioStreamRef.current.addTrack(e.track);
          setHasAudioTrack(true);

          // Update existing video streams with new audio track for synchronous lip-sync
          if (cameraStreamRef.current) {
            const videoTr = cameraStreamRef.current.getVideoTracks()[0];
            if (videoTr) {
              const updatedCam = new MediaStream([videoTr, e.track]);
              setCameraStream(updatedCam);
              setRemoteStream(updatedCam);
            }
          }
          if (screenStreamRef.current) {
            const screenTr = screenStreamRef.current.getVideoTracks()[0];
            if (screenTr) {
              setScreenStream(new MediaStream([screenTr, e.track]));
            }
          }
        } else if (kind === 'video') {
          const isCamMid = mid && mid === cameraTransceiverMidRef.current;
          const isScrMid = mid && mid === screenTransceiverMidRef.current;
          const isCamTransceiver = e.transceiver === cameraTransceiverRef.current;

          const isCamera = isCamMid || isCamTransceiver || (!isScrMid && !cameraStreamRef.current.getVideoTracks().length);

          const audioTracks = audioStreamRef.current.getAudioTracks();

          if (isCamera) {
            logToServer('Subscriber-RTC', 'Attached inbound track to cameraStream', {
              trackId: e.track.id,
              mid,
              readyState: e.track.readyState,
              muted: e.track.muted,
            });
            console.log('[WebRTC Subscriber] Attached to cameraStream');
            cameraStreamRef.current.getTracks().forEach((t) => {
              if (t.id !== e.track.id) cameraStreamRef.current.removeTrack(t);
            });
            cameraStreamRef.current.addTrack(e.track);
            const combinedCam = new MediaStream([e.track, ...audioTracks]);
            setCameraStream(combinedCam);
            setRemoteStream(combinedCam);
            setHasVideoTrack(true);
            requestKeyframe('video');
            setTimeout(() => requestKeyframe('video'), 800);
          } else {
            logToServer('Subscriber-RTC', 'Attached inbound track to screenStream', {
              trackId: e.track.id,
              mid,
              readyState: e.track.readyState,
              muted: e.track.muted,
            });
            console.log('[WebRTC Subscriber] Attached to screenStream');
            screenStreamRef.current.getTracks().forEach((t) => {
              if (t.id !== e.track.id) screenStreamRef.current.removeTrack(t);
            });
            screenStreamRef.current.addTrack(e.track);
            const combinedScr = new MediaStream([e.track, ...audioTracks]);
            setScreenStream(combinedScr);
            setHasScreenTrack(true);
            requestKeyframe('screen');
            setTimeout(() => requestKeyframe('screen'), 800);
          }

          e.track.onended = () => {
            logToServer('Subscriber-RTC', `Inbound track ended: kind=${kind}`);
            if (isCamera) setHasVideoTrack(false);
            else setHasScreenTrack(false);
          };
        }
      };

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
        logToServer('Subscriber-RTC', `PeerConnection state -> ${state}`);
        console.log(`[WebRTC Subscriber] Connection state: ${state}`);
        if (state === 'connected') {
          setIsRtcConnected(true);
          setRtcError(null);
          requestKeyframe('all');
          setTimeout(() => requestKeyframe('all'), 1000);
        } else if (state === 'disconnected' || state === 'failed') {
          setIsRtcConnected(false);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        logToServer('Subscriber-RTC', `ICE state -> ${state}`);
        console.log(`[WebRTC Subscriber] ICE state: ${state}`);
        if (state === 'connected' || state === 'completed') {
          setIsRtcConnected(true);
        } else if (state === 'failed') {
          pc.restartIce();
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      cameraTransceiverMidRef.current = cameraTransceiver.mid || '1';
      screenTransceiverMidRef.current = screenTransceiver.mid || '2';

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
  }, [roomId, requestKeyframe]);

  useEffect(() => {
    isCleaningUpRef.current = false;
    if (autoStart) {
      connectSFU();
    }

    return () => {
      isCleaningUpRef.current = true;
      clearTimeout(reconnectTimeoutRef.current);
      clearInterval(pingIntervalRef.current);
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
  }, [roomId, autoStart, connectSFU]);

  const toggleAudioMute = useCallback(() => {
    setIsAudioMuted((prev) => !prev);
  }, []);

  const setVolume = useCallback((val) => {
    const v = Math.max(0, Math.min(1, Number(val)));
    setVolumeState(v);
  }, []);

  return {
    remoteStream, // Backward-compat fallback (camera)
    cameraStream, // Full Resolution Presenter Camera
    screenStream, // Full Resolution Screen Share
    isRtcConnected,
    hasAudioTrack,
    hasVideoTrack,
    hasScreenTrack,
    isAudioMuted,
    volume,
    rtcError,
    toggleAudioMute,
    setVolume,
    requestKeyframe,
    retryWebRTC: connectSFU,
  };
}