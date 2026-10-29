use std::net::SocketAddr;
use std::time::Instant;
use str0m::change::SdpOffer;
use str0m::media::{KeyframeRequestKind, MediaData, MediaKind, Mid};
use str0m::net::{Protocol, Transmit};
use str0m::{Candidate, Event, Output, Rtc};
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::dashboard::{PeerSnapshot, PeerStats};
use crate::signaling::{CandidatePayload, ServerMessage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Publisher,
    Subscriber,
}

impl Role {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "publisher" | "broadcaster" => Some(Role::Publisher),
            "subscriber" | "viewer" => Some(Role::Subscriber),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Publisher => "publisher",
            Role::Subscriber => "subscriber",
        }
    }
}

pub struct PeerSession {
    pub peer_id: String,
    #[allow(dead_code)]
    pub room_id: String,
    pub role: Role,
    pub rtc: Rtc,
    pub audio_mid: Option<Mid>,
    pub video_mid: Option<Mid>,
    pub screen_mid: Option<Mid>,
    pub ws_sender: Option<UnboundedSender<ServerMessage>>,
    pub is_connected: bool,
    pub next_timeout: Instant,
    pub ice_state: String,
    pub remote_addr: Option<SocketAddr>,
    pub stats: PeerStats,
    #[allow(dead_code)]
    pub created_at: Instant,
}

impl PeerSession {
    /// Builds an Rtc instance with codecs configured in preferred order:
    /// Opus audio first, followed by Constrained Baseline H.264 (0x42e01f) so Apple VideoToolbox
    /// (iPad, iPhone, Safari) and Chromium browsers negotiate identical wire formats.
    pub fn build_rtc(now: Instant) -> Rtc {
        let mut builder = Rtc::builder()
            .clear_codecs()
            .enable_opus(true, false);

        // 1. Constrained Baseline Profile (0x42e01f) - Universal WebRTC H.264 profile (RFC 7742)
        // Packetization mode 1 (non-interleaved, FU-A) is primary; mode 0 is fallback
        builder.codec_config().add_h264(108.into(), Some(109.into()), true, 0x42e01f);
        builder.codec_config().add_h264(124.into(), Some(120.into()), false, 0x42e01f);
        // 2. High Profile (0x64001f / 0x640c1f) - Hardware-supported by Apple & modern PCs
        builder.codec_config().add_h264(114.into(), Some(115.into()), true, 0x64001f);
        // 3. Baseline Profile (0x42001f)
        builder.codec_config().add_h264(127.into(), Some(121.into()), true, 0x42001f);
        builder.codec_config().add_h264(125.into(), Some(107.into()), false, 0x42001f);
        // 4. Main Profile (0x4d001f)
        builder.codec_config().add_h264(123.into(), Some(119.into()), true, 0x4d001f);
        builder.codec_config().add_h264(35.into(), Some(36.into()), false, 0x4d001f);

        builder.build(now)
    }

    pub fn new(
        peer_id: String,
        room_id: String,
        role: Role,
        config: &Config,
        ws_sender: Option<UnboundedSender<ServerMessage>>,
    ) -> Result<Self, anyhow::Error> {
        let now = Instant::now();
        let mut rtc = Self::build_rtc(now);

        // 1. Always add loopback candidate (127.0.0.1:udp_port) for local browser connections on same machine
        let loopback_addr = SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
            config.udp_port,
        );
        if let Ok(cand) = Candidate::host(loopback_addr, Protocol::Udp) {
            rtc.add_local_candidate(cand);
        }

        // 2. Add LAN/VPC candidate (e.g. 192.168.1.12:udp_port or 172.31.34.87:udp_port on EC2)
        if let Some(lan_ip) = config.lan_ip {
            if !lan_ip.is_loopback() && Some(lan_ip) != Some(config.public_ip) {
                let lan_addr = SocketAddr::new(lan_ip, config.udp_port);
                if let Ok(cand) = Candidate::host(lan_addr, Protocol::Udp) {
                    rtc.add_local_candidate(cand);
                    info!("[Peer {}] Registered LAN/VPC candidate: {}", peer_id, lan_addr);
                }
            }
        }

        // 3. Add Public candidate if configured or detected (essential for cellular & internet clients)
        if !config.public_ip.is_loopback() {
            let pub_addr = config.public_media_addr();
            if let Ok(cand) = Candidate::host(pub_addr, Protocol::Udp) {
                rtc.add_local_candidate(cand);
                info!("[Peer {}] Registered Public candidate: {}", peer_id, pub_addr);
            }
        }

        Ok(Self {
            peer_id,
            room_id,
            role,
            rtc,
            audio_mid: None,
            video_mid: None,
            screen_mid: None,
            ws_sender,
            is_connected: false,
            next_timeout: now,
            ice_state: "New".to_string(),
            remote_addr: None,
            stats: PeerStats::default(),
            created_at: now,
        })
    }

    /// Process remote SDP offer, generate SDP answer, and register media MIDs
    pub fn handle_offer(
        &mut self,
        sdp: &str,
        tracks: Option<&crate::signaling::TrackMapping>,
    ) -> Result<String, anyhow::Error> {
        let mut offer_codecs = Vec::new();
        for line in sdp.lines() {
            let l = line.trim();
            if l.starts_with("m=") || l.starts_with("a=rtpmap:") || l.starts_with("a=fmtp:") {
                offer_codecs.push(l);
            }
        }
        info!(
            "[SFU-SDP] Peer {} ({}) Inbound Offer Codec Lines ({}):\n{}",
            self.peer_id,
            self.role.as_str(),
            offer_codecs.len(),
            offer_codecs.join("\n")
        );

        let offer = SdpOffer::from_sdp_string(sdp)?;
        let answer = self.rtc.sdp_api().accept_offer(offer)?;

        if let Some(t) = tracks {
            if let Some(a_mid) = &t.audio_mid {
                self.audio_mid = Some(Mid::from(a_mid.as_str()));
                info!("[Peer {}] Explicitly Mapped Audio MID: {}", self.peer_id, a_mid);
            }
            if let Some(v_mid) = &t.video_mid {
                self.video_mid = Some(Mid::from(v_mid.as_str()));
                info!("[Peer {}] Explicitly Mapped Camera Video MID: {}", self.peer_id, v_mid);
            }
            if let Some(s_mid) = &t.screen_mid {
                self.screen_mid = Some(Mid::from(s_mid.as_str()));
                info!("[Peer {}] Explicitly Mapped Screen Video MID: {}", self.peer_id, s_mid);
            }
        }

        // Map audio and video MIDs from negotiated media lines using rtc.media()
        for m in &answer.media_lines {
            let (kind, remote_pts) = if let Some(media) = self.rtc.media(m.mid()) {
                (Some(media.kind()), media.remote_pts().to_vec())
            } else {
                (None, Vec::new())
            };

            if let Some(kind) = kind {
                let writer_params: Vec<String> = self
                    .rtc
                    .writer(m.mid())
                    .map(|w| {
                        w.payload_params()
                            .map(|p| format!("PT {}: {:?}", p.pt(), p.spec().codec))
                            .collect()
                    })
                    .unwrap_or_default();
                info!(
                    "[SFU-SDP] Peer {} ({}) Negotiated MID {} ({:?}) | remote_pts: {:?} | writer_codecs: [{}]",
                    self.peer_id,
                    self.role.as_str(),
                    m.mid(),
                    kind,
                    remote_pts,
                    writer_params.join(", ")
                );

                match kind {
                    MediaKind::Audio => {
                        if self.audio_mid.is_none() {
                            self.audio_mid = Some(m.mid());
                            info!("[Peer {}] Auto-Mapped Audio MID: {}", self.peer_id, m.mid());
                        }
                    }
                    MediaKind::Video => {
                        if self.video_mid.is_none() {
                            self.video_mid = Some(m.mid());
                            info!("[Peer {}] Auto-Mapped Video MID: {}", self.peer_id, m.mid());
                        } else if self.screen_mid.is_none() && Some(m.mid()) != self.video_mid {
                            self.screen_mid = Some(m.mid());
                            info!("[Peer {}] Auto-Mapped Screen MID: {}", self.peer_id, m.mid());
                        }
                    }
                }
            }
        }

        let answer_sdp = answer.to_sdp_string();
        let mut answer_codecs = Vec::new();
        for line in answer_sdp.lines() {
            let l = line.trim();
            if l.starts_with("m=") || l.starts_with("a=rtpmap:") || l.starts_with("a=fmtp:") {
                answer_codecs.push(l);
            }
        }
        info!(
            "[SFU-SDP] Peer {} ({}) Outbound Answer Codec Lines ({}):\n{}",
            self.peer_id,
            self.role.as_str(),
            answer_codecs.len(),
            answer_codecs.join("\n")
        );

        Ok(answer_sdp)
    }

    /// Add a remote ICE candidate received from trickle ICE
    pub fn handle_candidate(&mut self, cand_payload: &CandidatePayload) -> Result<(), anyhow::Error> {
        let raw = cand_payload.candidate.trim();
        if raw.is_empty() {
            return Ok(());
        }

        let clean = if let Some(stripped) = raw.strip_prefix("a=") {
            stripped.trim()
        } else {
            raw
        };

        // Browser mDNS host candidate (.local) cannot be resolved without mDNS; skip gracefully
        if clean.contains(".local") {
            debug!("[Peer {}] Skipping mDNS candidate: {}", self.peer_id, clean);
            return Ok(());
        }

        match Candidate::from_sdp_string(clean) {
            Ok(cand) => {
                self.rtc.add_remote_candidate(cand);
                info!("[Peer {}] Added remote candidate: {}", self.peer_id, clean);
            }
            Err(e) => {
                debug!("[Peer {}] Ignored candidate '{}': {:?}", self.peer_id, clean, e);
            }
        }
        Ok(())
    }

    /// Request a video or screen keyframe (PLI) from this publisher
    pub fn request_keyframe(&mut self, kind: Option<&str>) {
        self.stats.keyframe_requests += 1;
        let req_video = kind.is_none() || kind == Some("video") || kind == Some("all");
        let req_screen = kind.is_none() || kind == Some("screen") || kind == Some("all");

        info!(
            "[SFU-Keyframe] Peer {} ({}) Keyframe requested (kind: {:?})",
            self.peer_id,
            self.role.as_str(),
            kind
        );

        if req_video {
            if let Some(video_mid) = self.video_mid {
                if let Some(rx) = self.rtc.direct_api().stream_rx_by_mid(video_mid, None) {
                    rx.request_keyframe(KeyframeRequestKind::Pli);
                    info!("[Peer {}] Dispatched PLI keyframe request for Video MID {}", self.peer_id, video_mid);
                } else {
                    warn!("[Peer {}] stream_rx_by_mid for Video MID {} not found", self.peer_id, video_mid);
                }
            } else {
                warn!("[Peer {}] video_mid is None, cannot request video keyframe", self.peer_id);
            }
        }

        if req_screen {
            if let Some(screen_mid) = self.screen_mid {
                if let Some(rx) = self.rtc.direct_api().stream_rx_by_mid(screen_mid, None) {
                    rx.request_keyframe(KeyframeRequestKind::Pli);
                    info!("[Peer {}] Dispatched PLI keyframe request for Screen MID {}", self.peer_id, screen_mid);
                } else {
                    warn!("[Peer {}] stream_rx_by_mid for Screen MID {} not found", self.peer_id, screen_mid);
                }
            } else {
                debug!("[Peer {}] screen_mid is None, skipping screen keyframe", self.peer_id);
            }
        }
    }

    /// Drain pending outputs from str0m::Rtc:
    /// - Collects outgoing network transmits
    /// - Collects incoming MediaData events
    /// - Handles connection state changes
    /// - Returns any keyframe requests needed
    pub fn drain_outputs(
        &mut self,
        transmits: &mut Vec<Transmit>,
        media_frames: &mut Vec<MediaData>,
        keyframe_requested: &mut bool,
    ) {
        while let Ok(output) = self.rtc.poll_output() {
            match output {
                Output::Transmit(t) => {
                    self.stats.bytes_out += t.contents.len() as u64;
                    self.stats.packets_out += 1;
                    transmits.push(t);
                }
                Output::Event(event) => match event {
                    Event::Connected => {
                        info!("[Peer {} ({:?})] WebRTC Peer Connection ESTABLISHED!", self.peer_id, self.role);
                        self.is_connected = true;
                        self.ice_state = "Connected".to_string();
                    }
                    Event::IceConnectionStateChange(state) => {
                        info!("[Peer {}] ICE state change: {:?}", self.peer_id, state);
                        self.ice_state = format!("{:?}", state);
                        let s = self.ice_state.to_lowercase();
                        if s.contains("connected") || s.contains("completed") {
                            self.is_connected = true;
                        } else if s.contains("disconnected") || s.contains("failed") {
                            self.is_connected = false;
                        }
                    }
                    Event::MediaData(data) => {
                        media_frames.push(data);
                    }
                    Event::KeyframeRequest(req) => {
                        debug!("[Peer {}] Received KeyframeRequest: {:?}", self.peer_id, req);
                        self.stats.keyframe_requests += 1;
                        *keyframe_requested = true;
                    }
                    _ => {}
                },
                Output::Timeout(t) => {
                    self.next_timeout = t;
                    break;
                }
            }
        }
    }

    /// Convert this peer's live WebRTC state into a diagnostic snapshot for the dashboard
    pub fn to_snapshot(&self, now: Instant) -> PeerSnapshot {
        PeerSnapshot {
            peer_id: self.peer_id.clone(),
            role: self.role.as_str().to_string(),
            remote_addr: self.remote_addr.map(|a| a.to_string()),
            is_connected: self.is_connected,
            ice_state: self.ice_state.clone(),
            ws_connected: self.ws_sender.is_some(),
            audio_mid: self.audio_mid.map(|m| m.to_string()),
            video_mid: self.video_mid.map(|m| m.to_string()),
            screen_mid: self.screen_mid.map(|m| m.to_string()),
            stats: self.stats.snapshot(now),
        }
    }

    /// Sends a message over this peer's WebSocket signaling channel if available
    pub fn send_signal(&self, msg: ServerMessage) {
        if let Some(tx) = &self.ws_sender {
            let _ = tx.send(msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_candidate_parsing() {
        let sdp1 = "candidate:842163049 1 udp 1677729535 127.0.0.1 54321 typ host generation 0";
        let c1 = Candidate::from_sdp_string(sdp1);
        println!("c1: {:?}", c1);

        let sdp2 = "a=candidate:842163049 1 udp 1677729535 127.0.0.1 54321 typ host generation 0";
        let c2 = Candidate::from_sdp_string(sdp2);
        println!("c2: {:?}", c2);

        let sdp_mdns = "candidate:42345432 1 udp 2113937151 74cb0804-0ee0-449a-a82f-2d64115456f5.local 54322 typ host";
        let c_mdns = Candidate::from_sdp_string(sdp_mdns);
        println!("c_mdns: {:?}", c_mdns);

        let sdp_tcp = "candidate:123456 1 tcp 1518280447 127.0.0.1 9 typ host tcptype active";
        let c_tcp = Candidate::from_sdp_string(sdp_tcp);
        println!("c_tcp: {:?}", c_tcp);

        let sdp_empty = "";
        let c_empty = Candidate::from_sdp_string(sdp_empty);
        println!("c_empty: {:?}", c_empty);

        // Multiple candidates test
        let mut rtc = Rtc::builder().build(Instant::now());
        let c_local = Candidate::host("127.0.0.1:40000".parse().unwrap(), Protocol::Udp).unwrap();
        let c_lan = Candidate::host("192.168.1.12:40000".parse().unwrap(), Protocol::Udp).unwrap();
        assert!(rtc.add_local_candidate(c_local).is_some());
        assert!(rtc.add_local_candidate(c_lan).is_some());

        let mut client_rtc = Rtc::builder().build(Instant::now());
        let mut change = client_rtc.sdp_api();
        change.add_media(MediaKind::Audio, str0m::media::Direction::RecvOnly, None, None, None);
        change.add_media(MediaKind::Video, str0m::media::Direction::RecvOnly, None, None, None);
        let (offer, _pending) = change.apply().unwrap();
        let answer = rtc.sdp_api().accept_offer(offer).unwrap();
        println!("=== DUAL CANDIDATE ANSWER SDP ===\n{}", answer.to_sdp_string());
    }

    #[test]
    fn test_multi_video_sdp_negotiation() {
        let mut rtc = Rtc::builder().build(Instant::now());
        let mut client_rtc = Rtc::builder().build(Instant::now());
        let mut change = client_rtc.sdp_api();
        change.add_media(MediaKind::Audio, str0m::media::Direction::SendOnly, None, None, None);
        change.add_media(MediaKind::Video, str0m::media::Direction::SendOnly, None, None, None); // camera
        change.add_media(MediaKind::Video, str0m::media::Direction::SendOnly, None, None, None); // screen
        let (offer, _pending) = change.apply().unwrap();
        assert_eq!(offer.media_lines.len(), 3);

        let answer = rtc.sdp_api().accept_offer(offer).unwrap();
        assert_eq!(answer.media_lines.len(), 3);
        let m0 = &answer.media_lines[0];
        let m1 = &answer.media_lines[1];
        let m2 = &answer.media_lines[2];
        assert_eq!(rtc.media(m0.mid()).unwrap().kind(), MediaKind::Audio);
        assert_eq!(rtc.media(m1.mid()).unwrap().kind(), MediaKind::Video);
        assert_eq!(rtc.media(m2.mid()).unwrap().kind(), MediaKind::Video);
    }

    #[test]
    fn test_chrome_offer_h264_negotiation() {
        use str0m::media::Direction;
        let now = Instant::now();
        // Server: ONLY H264 and Opus enabled with prioritized Constrained Baseline
        let mut server = PeerSession::build_rtc(now);

        // Client (like Chrome): default codecs (VP8, VP9, H264)
        let mut client = Rtc::builder().build(now);
        let mut change = client.sdp_api();
        change.add_media(MediaKind::Audio, Direction::SendOnly, None, None, None);
        let v_mid = change.add_media(MediaKind::Video, Direction::SendOnly, None, None, None);
        let (offer, pending) = change.apply().unwrap();

        // Server accepts
        let answer = server.sdp_api().accept_offer(offer).unwrap();
        let answer_str = answer.to_sdp_string();
        println!("Server Answer SDP:\n{}", answer_str);

        // Client accepts answer
        client.sdp_api().accept_answer(pending, answer).unwrap();

        // Check negotiated codec on video line for server
        let server_video = server.media(v_mid).unwrap();
        let server_pts = server_video.remote_pts();
        println!("Server video negotiated remote PTs: {:?}", server_pts);
        assert!(!server_pts.is_empty(), "Server should have negotiated video PT");
    }

    #[test]
    fn test_accepts_with_unspecified_destination() {
        use str0m::media::Direction;
        use str0m::net::Receive;
        use str0m::Input;
        let now = Instant::now();
        let mut server_rtc = Rtc::builder().build(now);
        let server_cand = Candidate::host("127.0.0.1:40000".parse().unwrap(), Protocol::Udp).unwrap();
        server_rtc.add_local_candidate(server_cand);
        let server_cand2 = Candidate::host("192.168.1.12:40000".parse().unwrap(), Protocol::Udp).unwrap();
        server_rtc.add_local_candidate(server_cand2);

        let mut client_rtc = Rtc::builder().build(now);
        let client_cand = Candidate::host("127.0.0.1:50000".parse().unwrap(), Protocol::Udp).unwrap();
        client_rtc.add_local_candidate(client_cand);

        let mut change = client_rtc.sdp_api();
        change.add_media(MediaKind::Audio, Direction::RecvOnly, None, None, None);
        let (offer, pending) = change.apply().unwrap();
        let answer = server_rtc.sdp_api().accept_offer(offer).unwrap();
        let _ = client_rtc.sdp_api().accept_answer(pending, answer).unwrap();

        // Let client generate STUN binding request packet
        let _ = client_rtc.handle_input(Input::Timeout(now));
        let mut client_transmits = Vec::new();
        while let Ok(out) = client_rtc.poll_output() {
            match out {
                Output::Transmit(t) => client_transmits.push(t),
                Output::Timeout(_) => break,
                _ => {}
            }
        }
        assert!(!client_transmits.is_empty(), "Client should output transmits");

        // Drive both until Connected
        let mut client_connected = false;
        let mut server_connected = false;
        let mut cur_time = now;

        for step in 0..200 {
            cur_time += std::time::Duration::from_millis(10);
            let _ = client_rtc.handle_input(Input::Timeout(cur_time));
            let _ = server_rtc.handle_input(Input::Timeout(cur_time));

            let mut c_to_s = Vec::new();
            while let Ok(out) = client_rtc.poll_output() {
                match out {
                    Output::Transmit(t) => c_to_s.push(t),
                    Output::Event(Event::Connected) => client_connected = true,
                    Output::Timeout(_) => break,
                    _ => {}
                }
            }

            let mut s_to_c = Vec::new();
            while let Ok(out) = server_rtc.poll_output() {
                match out {
                    Output::Transmit(t) => s_to_c.push(t),
                    Output::Event(Event::Connected) => server_connected = true,
                    Output::Timeout(_) => break,
                    _ => {}
                }
            }

            for t in c_to_s {
                let dest = if t.source.ip().is_loopback() {
                    "127.0.0.1:40000".parse().unwrap()
                } else {
                    "192.168.1.12:40000".parse().unwrap()
                };
                let inp = Input::Receive(
                    cur_time,
                    Receive {
                        proto: Protocol::Udp,
                        source: t.source,
                        destination: dest,
                        contents: t.contents.as_ref().try_into().unwrap(),
                    },
                );
                if server_rtc.accepts(&inp) {
                    let _ = server_rtc.handle_input(inp);
                }
            }

            for t in s_to_c {
                let inp = Input::Receive(
                    cur_time,
                    Receive {
                        proto: Protocol::Udp,
                        source: t.source,
                        destination: t.destination,
                        contents: t.contents.as_ref().try_into().unwrap(),
                    },
                );
                if client_rtc.accepts(&inp) {
                    let _ = client_rtc.handle_input(inp);
                }
            }

            if client_connected && server_connected {
                println!("Connected in step {}", step);
                break;
            }
        }

        assert!(client_connected, "Client should be connected");
        assert!(server_connected, "Server should be connected");
    }
}
