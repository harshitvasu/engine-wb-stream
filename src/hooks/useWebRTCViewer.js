import { useState, useEffect, useRef, useCallback } from 'react';
import { getSfuWebSocketUrl } from '../config/constants';

/**
 * Custom hook for Viewers / Subscribers to:
 * - Establish an encrypted WebRTC PeerConnection with the custom Rust SFU
 * - Receive live Opus audio and VP8 video thumbnail tracks
 * - Maintain periodic signaling heartbeats (5s ping) to prevent mobile Wi-Fi / Safari idle drops
 * - Resiliently handle signaling drops without interrupting live UDP media playback
 * - Request keyframes (PLI) upon join so video starts decoding without delay
 * - Control audio mute, volume, and handle reconnects
 */
export function useWebRTCViewer({ roomId = 'default', autoStart = true } = {}) {
  const [remoteStream, setRemoteStream] = useState(null);
  const [isRtcConnected, setIsRtcConnected] = useState(false);
  const [hasAudioTrack, setHasAudioTrack] = useState(false);
  const [hasVideoTrack, setHasVideoTrack] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [volume, setVolumeState] = useState(1.0);
  const [rtcError, setRtcError] = useState(null);

  const pcRef = useRef(null);
  const wsRef = useRef(null);
  const peerIdRef = useRef(`sub-${Math.random().toString(36).substring(2, 9)}`);
  const incomingStreamRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const pingIntervalRef = useRef(null);
  const isCleaningUpRef = useRef(false);

  const requestKeyframe = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'request_keyframe',
          peerId: peerIdRef.current,
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
            // Heartbeat acknowledged by SFU
            break;

          case 'joined': {
            console.log(`[WebRTC Subscriber] Registered in room ${roomId}`);
            await createAndSendOffer();
            break;
          }

          case 'answer': {
            if (pcRef.current && msg.sdp) {
              console.log('[WebRTC Subscriber] Received SDP answer from SFU');
              await pcRef.current.setRemoteDescription(
                new RTCSessionDescription({ type: 'answer', sdp: msg.sdp })
              );
              // Request keyframe so video decoder locks onto an IDR frame immediately
              requestKeyframe();
              setTimeout(requestKeyframe, 800);
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
            console.log('[WebRTC Subscriber] Tracks available notification from SFU:', msg);
            if (msg.video) {
              requestKeyframe();
              setTimeout(requestKeyframe, 800);
            }
            break;
          }

          case 'peer_disconnected': {
            console.log('[WebRTC Subscriber] Publisher disconnected');
            setHasAudioTrack(false);
            setHasVideoTrack(false);
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
            // If WebRTC is currently connected and active, only reconnect the signaling channel!
            // Do NOT tear down the active UDP audio/video media stream.
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
          if (msg.type === 'tracks_available' && msg.video) {
            requestKeyframe();
          } else if (msg.type === 'peer_disconnected') {
            setHasAudioTrack(false);
            setHasVideoTrack(false);
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

      const incomingStream = new MediaStream();
      incomingStreamRef.current = incomingStream;
      setRemoteStream(incomingStream);

      // Add receive-only transceivers bundled into the exact same MediaStream instance
      pc.addTransceiver('audio', { direction: 'recvonly', streams: [incomingStream] });
      pc.addTransceiver('video', { direction: 'recvonly', streams: [incomingStream] });

      pc.ontrack = (e) => {
        console.log(`[WebRTC Subscriber] Inbound track received: kind=${e.track.kind}, id=${e.track.id}`);
        const stream = incomingStreamRef.current || incomingStream;
        if (!stream.getTracks().some((t) => t.id === e.track.id)) {
          stream.addTrack(e.track);
        }
        if (e.streams && e.streams[0]) {
          e.streams[0].getTracks().forEach((track) => {
            if (!stream.getTracks().some((t) => t.id === track.id)) {
              stream.addTrack(track);
            }
          });
        }
        setRemoteStream(stream);

        if (e.track.kind === 'audio') {
          setHasAudioTrack(true);
        } else if (e.track.kind === 'video') {
          setHasVideoTrack(true);
          requestKeyframe();
          setTimeout(requestKeyframe, 800);
        }

        e.track.onended = () => {
          if (e.track.kind === 'audio') setHasAudioTrack(false);
          if (e.track.kind === 'video') setHasVideoTrack(false);
        };
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
        console.log(`[WebRTC Subscriber] Connection state: ${state}`);
        if (state === 'connected') {
          setIsRtcConnected(true);
          setRtcError(null);
          requestKeyframe();
          setTimeout(requestKeyframe, 1000);
        } else if (state === 'disconnected' || state === 'failed') {
          setIsRtcConnected(false);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log(`[WebRTC Subscriber] ICE state: ${state}`);
        if (state === 'connected' || state === 'completed') {
          setIsRtcConnected(true);
        } else if (state === 'failed') {
          pc.restartIce();
        }
      };

      const offer = await pc.createOffer();
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
    remoteStream,
    isRtcConnected,
    hasAudioTrack,
    hasVideoTrack,
    isAudioMuted,
    volume,
    rtcError,
    toggleAudioMute,
    setVolume,
    requestKeyframe,
    retryWebRTC: connectSFU,
  };
}
