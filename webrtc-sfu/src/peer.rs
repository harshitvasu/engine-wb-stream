use std::net::SocketAddr;
use std::time::Instant;
use str0m::change::SdpOffer;
use str0m::media::{KeyframeRequestKind, MediaData, MediaKind, Mid};
use str0m::net::{Protocol, Transmit};
use str0m::{Candidate, Event, Output, Rtc};
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, info};

use crate::config::Config;
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
}

impl PeerSession {
    pub fn new(
        peer_id: String,
        room_id: String,
        role: Role,
        config: &Config,
        ws_sender: Option<UnboundedSender<ServerMessage>>,
    ) -> Result<Self, anyhow::Error> {
        let now = Instant::now();
        let mut rtc = Rtc::builder().build(now);

        // 1. Always add loopback candidate (127.0.0.1:udp_port) for local browser connections on same machine
        let loopback_addr = SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
            config.udp_port,
        );
        if let Ok(cand) = Candidate::host(loopback_addr, Protocol::Udp) {
            rtc.add_local_candidate(cand);
        }

        // 2. Always add LAN candidate (e.g. 192.168.1.12:udp_port) for Wi-Fi/local network clients (iPad, iPhone, etc.)
        if let Some(lan_ip) = config.lan_ip {
            if !lan_ip.is_loopback() {
                let lan_addr = SocketAddr::new(lan_ip, config.udp_port);
                if let Ok(cand) = Candidate::host(lan_addr, Protocol::Udp) {
                    rtc.add_local_candidate(cand);
                    info!("[Peer {}] Registered LAN candidate for Wi-Fi clients: {}", peer_id, lan_addr);
                }
            }
        }

        // 3. Add public IP candidate if explicitly set and distinct from loopback and LAN
        if !config.public_ip.is_loopback() && Some(config.public_ip) != config.lan_ip {
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
        })
    }

    /// Process remote SDP offer, generate SDP answer, and register media MIDs
    pub fn handle_offer(
        &mut self,
        sdp: &str,
        tracks: Option<&crate::signaling::TrackMapping>,
    ) -> Result<String, anyhow::Error> {
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
            if let Some(media) = self.rtc.media(m.mid()) {
                match media.kind() {
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
        let req_video = kind.is_none() || kind == Some("video") || kind == Some("all");
        let req_screen = kind.is_none() || kind == Some("screen") || kind == Some("all");

        if req_video {
            if let Some(video_mid) = self.video_mid {
                if let Some(rx) = self.rtc.direct_api().stream_rx_by_mid(video_mid, None) {
                    rx.request_keyframe(KeyframeRequestKind::Pli);
                    debug!("[Peer {}] Dispatched PLI keyframe request for Video MID {}", self.peer_id, video_mid);
                }
            }
        }

        if req_screen {
            if let Some(screen_mid) = self.screen_mid {
                if let Some(rx) = self.rtc.direct_api().stream_rx_by_mid(screen_mid, None) {
                    rx.request_keyframe(KeyframeRequestKind::Pli);
                    debug!("[Peer {}] Dispatched PLI keyframe request for Screen MID {}", self.peer_id, screen_mid);
                }
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
                    transmits.push(t);
                }
                Output::Event(event) => match event {
                    Event::Connected => {
                        info!("[Peer {} ({:?})] WebRTC Peer Connection ESTABLISHED!", self.peer_id, self.role);
                        self.is_connected = true;
                    }
                    Event::IceConnectionStateChange(state) => {
                        info!("[Peer {}] ICE state change: {:?}", self.peer_id, state);
                    }
                    Event::MediaData(data) => {
                        media_frames.push(data);
                    }
                    Event::KeyframeRequest(req) => {
                        debug!("[Peer {}] Received KeyframeRequest: {:?}", self.peer_id, req);
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
