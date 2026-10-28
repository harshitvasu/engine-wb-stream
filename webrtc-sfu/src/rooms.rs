use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use str0m::net::{Protocol, Receive, Transmit};
use str0m::Input;
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, info};

use crate::config::Config;
use crate::media::MediaRouter;
use crate::metrics::Metrics;
use crate::peer::{PeerSession, Role};
use crate::signaling::{CandidatePayload, ServerMessage, TrackMapping};

pub struct Room {
    #[allow(dead_code)]
    pub id: String,
    pub publisher: Option<PeerSession>,
    pub subscribers: HashMap<String, PeerSession>,
}

impl Room {
    pub fn new(id: String) -> Self {
        Self {
            id,
            publisher: None,
            subscribers: HashMap::new(),
        }
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.publisher.is_none() && self.subscribers.is_empty()
    }
}

pub struct RoomManager {
    pub rooms: HashMap<String, Room>,
    pub config: Config,
    pub metrics: Arc<Metrics>,
}

impl RoomManager {
    pub fn new(config: Config, metrics: Arc<Metrics>) -> Self {
        Self {
            rooms: HashMap::new(),
            config,
            metrics,
        }
    }

    pub fn join(
        &mut self,
        room_id: String,
        role_str: &str,
        peer_id: String,
        ws_sender: Option<UnboundedSender<ServerMessage>>,
    ) -> Result<Role, anyhow::Error> {
        let role = Role::from_str(role_str)
            .ok_or_else(|| anyhow::anyhow!("Invalid role: {}", role_str))?;

        let room = self
            .rooms
            .entry(room_id.clone())
            .or_insert_with(|| {
                self.metrics.inc_rooms();
                Room::new(room_id.clone())
            });

        let session = PeerSession::new(
            peer_id.clone(),
            room_id.clone(),
            role,
            &self.config,
            ws_sender.clone(),
        )?;

        match role {
            Role::Publisher => {
                if let Some(existing) = &mut room.publisher {
                    let is_same_peer = existing.peer_id == peer_id;
                    let is_ws_dead = existing.ws_sender.is_none();
                    if is_same_peer || is_ws_dead || !existing.is_connected {
                        info!(
                            "[Room {}] Replacing previous Publisher ({}) with fresh session ({})",
                            room_id, existing.peer_id, peer_id
                        );
                        room.publisher = None;
                        self.metrics.dec_publishers();
                    } else {
                        return Err(anyhow::anyhow!(
                            "Publisher limit exceeded: an active publisher is already broadcasting in room '{}'",
                            room_id
                        ));
                    }
                }
                room.publisher = Some(session);
                self.metrics.inc_publishers();
                info!("[Room {}] Registered new Publisher ({})", room_id, peer_id);

                // Notify all current subscribers that publisher has joined
                for sub in room.subscribers.values() {
                    sub.send_signal(ServerMessage::TracksAvailable {
                        audio: true,
                        video: true,
                        screen: false,
                    });
                }
            }
            Role::Subscriber => {
                if let Some(existing) = room.subscribers.get_mut(&peer_id) {
                    info!("[Room {}] Subscriber ({}) re-attached signaling channel", room_id, peer_id);
                    existing.ws_sender = ws_sender;
                    if let Some(pub_session) = &room.publisher {
                        existing.send_signal(ServerMessage::TracksAvailable {
                            audio: pub_session.audio_mid.is_some(),
                            video: pub_session.video_mid.is_some(),
                            screen: pub_session.screen_mid.is_some(),
                        });
                    }
                    return Ok(role);
                }

                if room.subscribers.insert(peer_id.clone(), session).is_none() {
                    self.metrics.inc_subscribers();
                }
                info!(
                    "[Room {}] Registered new Subscriber ({}), total: {}",
                    room_id,
                    peer_id,
                    room.subscribers.len()
                );

                // If publisher exists, notify subscriber and request an immediate keyframe
                if let Some(pub_session) = &mut room.publisher {
                    pub_session.request_keyframe(None);
                    self.metrics.inc_keyframe_requests();
                    if let Some(sub) = room.subscribers.get(&peer_id) {
                        sub.send_signal(ServerMessage::TracksAvailable {
                            audio: pub_session.audio_mid.is_some(),
                            video: pub_session.video_mid.is_some(),
                            screen: pub_session.screen_mid.is_some(),
                        });
                    }
                }
            }
        }

        Ok(role)
    }

    pub fn handle_offer(
        &mut self,
        room_id: &str,
        peer_id: &str,
        sdp: &str,
        tracks: Option<&TrackMapping>,
    ) -> Result<(String, Vec<Transmit>), anyhow::Error> {
        let room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| anyhow::anyhow!("Room not found: {}", room_id))?;

        let mut transmits = Vec::new();
        let mut frames = Vec::new();
        let mut keyframe_requested = false;

        let answer_sdp = if let Some(pub_session) = &mut room.publisher {
            if pub_session.peer_id == peer_id {
                let answer = pub_session.handle_offer(sdp, tracks)?;
                pub_session.drain_outputs(&mut transmits, &mut frames, &mut keyframe_requested);
                let has_audio = pub_session.audio_mid.is_some();
                let has_video = pub_session.video_mid.is_some();
                let has_screen = pub_session.screen_mid.is_some();
                for sub in room.subscribers.values() {
                    sub.send_signal(ServerMessage::TracksAvailable {
                        audio: has_audio,
                        video: has_video,
                        screen: has_screen,
                    });
                }
                answer
            } else if let Some(sub_session) = room.subscribers.get_mut(peer_id) {
                let answer = sub_session.handle_offer(sdp, tracks)?;
                sub_session.drain_outputs(&mut transmits, &mut frames, &mut keyframe_requested);
                // Also trigger keyframe on publisher for the new subscriber and drain transmits
                pub_session.request_keyframe(None);
                let mut pub_frames = Vec::new();
                let mut pub_kf = false;
                pub_session.drain_outputs(&mut transmits, &mut pub_frames, &mut pub_kf);
                answer
            } else {
                return Err(anyhow::anyhow!("Peer not found: {}", peer_id));
            }
        } else if let Some(sub_session) = room.subscribers.get_mut(peer_id) {
            let answer = sub_session.handle_offer(sdp, tracks)?;
            sub_session.drain_outputs(&mut transmits, &mut frames, &mut keyframe_requested);
            answer
        } else {
            return Err(anyhow::anyhow!("Peer not found: {}", peer_id));
        };

        Ok((answer_sdp, transmits))
    }

    pub fn handle_candidate(
        &mut self,
        room_id: &str,
        peer_id: &str,
        cand: &CandidatePayload,
    ) -> Result<Vec<Transmit>, anyhow::Error> {
        let room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| anyhow::anyhow!("Room not found: {}", room_id))?;

        let mut transmits = Vec::new();
        let mut frames = Vec::new();
        let mut keyframe_requested = false;

        if let Some(pub_session) = &mut room.publisher {
            if pub_session.peer_id == peer_id {
                let res = pub_session.handle_candidate(cand);
                pub_session.drain_outputs(&mut transmits, &mut frames, &mut keyframe_requested);
                res?;
                return Ok(transmits);
            }
        }

        if let Some(sub_session) = room.subscribers.get_mut(peer_id) {
            let res = sub_session.handle_candidate(cand);
            sub_session.drain_outputs(&mut transmits, &mut frames, &mut keyframe_requested);
            res?;
            return Ok(transmits);
        }

        Err(anyhow::anyhow!("Peer not found: {}", peer_id))
    }

    pub fn request_keyframe(&mut self, room_id: &str, _peer_id: &str, kind: Option<&str>) -> Vec<Transmit> {
        let mut transmits = Vec::new();
        if let Some(room) = self.rooms.get_mut(room_id) {
            if let Some(pub_session) = &mut room.publisher {
                pub_session.request_keyframe(kind);
                self.metrics.inc_keyframe_requests();
                let mut frames = Vec::new();
                let mut kf = false;
                pub_session.drain_outputs(&mut transmits, &mut frames, &mut kf);
            }
        }
        transmits
    }

    pub fn handle_tracks_update(
        &mut self,
        room_id: &str,
        peer_id: &str,
        audio: bool,
        video: bool,
        screen: bool,
    ) {
        if let Some(room) = self.rooms.get_mut(room_id) {
            if let Some(pub_session) = &room.publisher {
                if pub_session.peer_id == peer_id {
                    for sub in room.subscribers.values() {
                        sub.send_signal(ServerMessage::TracksAvailable {
                            audio,
                            video,
                            screen,
                        });
                    }
                }
            }
        }
    }

    /// Ingests an incoming raw UDP media/ICE packet and attributes it to the matching peer session
    pub fn handle_udp_packet(&mut self, source: SocketAddr, contents: &[u8], transmits: &mut Vec<Transmit>) {
        self.metrics.inc_udp_recv();

        let loopback_dest = SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
            self.config.udp_port,
        );
        let lan_dest = self.config.lan_ip.map(|ip| SocketAddr::new(ip, self.config.udp_port));
        let public_dest = if !self.config.public_ip.is_loopback() {
            Some(self.config.public_media_addr())
        } else {
            None
        };

        // Order candidate destinations according to sender origin (loopback vs remote/LAN)
        let mut candidate_dests = Vec::with_capacity(3);
        if source.ip().is_loopback() {
            candidate_dests.push(loopback_dest);
            if let Some(lan) = lan_dest {
                if !candidate_dests.contains(&lan) { candidate_dests.push(lan); }
            }
            if let Some(pub_d) = public_dest {
                if !candidate_dests.contains(&pub_d) { candidate_dests.push(pub_d); }
            }
        } else {
            if let Some(lan) = lan_dest {
                candidate_dests.push(lan);
            }
            if let Some(pub_d) = public_dest {
                if !candidate_dests.contains(&pub_d) { candidate_dests.push(pub_d); }
            }
            if !candidate_dests.contains(&loopback_dest) {
                candidate_dests.push(loopback_dest);
            }
        }

        let now = Instant::now();

        for room in self.rooms.values_mut() {
            // Check publisher with candidates
            if let Some(pub_session) = &mut room.publisher {
                for &dest in &candidate_dests {
                    let input = Input::Receive(
                        now,
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: dest,
                            contents: match contents.try_into() {
                                Ok(c) => c,
                                Err(_) => return,
                            },
                        },
                    );

                    if pub_session.rtc.accepts(&input) {
                        if let Err(e) = pub_session.rtc.handle_input(input) {
                            debug!("[Pub {}] Error handling input: {:?}", pub_session.peer_id, e);
                        }
                        let mut frames = Vec::new();
                        let mut kf = false;
                        pub_session.drain_outputs(transmits, &mut frames, &mut kf);

                        let pub_audio = pub_session.audio_mid;
                        let pub_video = pub_session.video_mid;
                        let pub_screen = pub_session.screen_mid;

                        // Forward media frames to subscribers
                        for frame in &frames {
                            MediaRouter::forward_frame(
                                frame,
                                pub_audio,
                                pub_video,
                                pub_screen,
                                &mut room.subscribers,
                                &self.metrics,
                                transmits,
                            );
                        }
                        return;
                    }
                }
            }

            // Check subscribers with candidates
            for sub_session in room.subscribers.values_mut() {
                for &dest in &candidate_dests {
                    let input = Input::Receive(
                        now,
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: dest,
                            contents: match contents.try_into() {
                                Ok(c) => c,
                                Err(_) => return,
                            },
                        },
                    );

                    if sub_session.rtc.accepts(&input) {
                        if let Err(e) = sub_session.rtc.handle_input(input) {
                            debug!("[Sub {}] Error handling input: {:?}", sub_session.peer_id, e);
                        }
                        let mut frames = Vec::new();
                        let mut keyframe_requested = false;
                        sub_session.drain_outputs(transmits, &mut frames, &mut keyframe_requested);

                        if keyframe_requested {
                            if let Some(pub_session) = &mut room.publisher {
                                pub_session.request_keyframe(None);
                                self.metrics.inc_keyframe_requests();
                                let mut pub_frames = Vec::new();
                                let mut pub_kf = false;
                                pub_session.drain_outputs(transmits, &mut pub_frames, &mut pub_kf);
                            }
                        }
                        return;
                    }
                }
            }
        }
    }

    pub fn handle_timeout_tick(&mut self, now: Instant, transmits: &mut Vec<Transmit>) {
        for room in self.rooms.values_mut() {
            let mut frames = Vec::new();
            let mut pub_audio = None;
            let mut pub_video = None;
            let mut pub_screen = None;

            if let Some(pub_session) = &mut room.publisher {
                pub_audio = pub_session.audio_mid;
                pub_video = pub_session.video_mid;
                pub_screen = pub_session.screen_mid;

                if now >= pub_session.next_timeout {
                    let _ = pub_session.rtc.handle_input(Input::Timeout(now));
                    let mut kf = false;
                    pub_session.drain_outputs(transmits, &mut frames, &mut kf);
                }
            }

            // Forward any media frames generated during tick
            for frame in &frames {
                MediaRouter::forward_frame(
                    frame,
                    pub_audio,
                    pub_video,
                    pub_screen,
                    &mut room.subscribers,
                    &self.metrics,
                    transmits,
                );
            }

            for sub_session in room.subscribers.values_mut() {
                if now >= sub_session.next_timeout {
                    let _ = sub_session.rtc.handle_input(Input::Timeout(now));
                    let mut dummy_frames = Vec::new();
                    let mut keyframe_requested = false;
                    sub_session.drain_outputs(transmits, &mut dummy_frames, &mut keyframe_requested);
                    if keyframe_requested {
                        if let Some(pub_session) = &mut room.publisher {
                            pub_session.request_keyframe(None);
                            self.metrics.inc_keyframe_requests();
                            let mut pub_frames = Vec::new();
                            let mut pub_kf = false;
                            pub_session.drain_outputs(transmits, &mut pub_frames, &mut pub_kf);
                        }
                    }
                }
            }
        }
    }

    pub fn handle_ws_disconnect(&mut self, room_id: &str, peer_id: &str) {
        if let Some(room) = self.rooms.get_mut(room_id) {
            if let Some(pub_session) = &mut room.publisher {
                if pub_session.peer_id == peer_id {
                    pub_session.ws_sender = None;
                    if !pub_session.is_connected {
                        info!("[Room {}] Removed inactive Publisher ({}) on WS close", room_id, peer_id);
                        room.publisher = None;
                        self.metrics.dec_publishers();
                    } else {
                        info!("[Room {}] Publisher ({}) WS dropped; WebRTC UDP media remains active", room_id, peer_id);
                    }
                    return;
                }
            }

            if let Some(sub_session) = room.subscribers.get_mut(peer_id) {
                sub_session.ws_sender = None;
                if !sub_session.is_connected {
                    room.subscribers.remove(peer_id);
                    self.metrics.dec_subscribers();
                    info!("[Room {}] Removed inactive Subscriber ({}) on WS close", room_id, peer_id);
                } else {
                    info!("[Room {}] Subscriber ({}) WS dropped; WebRTC UDP media remains active", room_id, peer_id);
                }
            }
        }
    }

    pub fn leave(&mut self, room_id: &str, peer_id: &str) {
        if let Some(room) = self.rooms.get_mut(room_id) {
            if let Some(pub_session) = &room.publisher {
                if pub_session.peer_id == peer_id {
                    info!("[Room {}] Publisher ({}) disconnected", room_id, peer_id);
                    room.publisher = None;
                    self.metrics.dec_publishers();
                    // Notify subscribers
                    for sub in room.subscribers.values() {
                        sub.send_signal(ServerMessage::PeerDisconnected {
                            peer_id: peer_id.to_string(),
                        });
                        sub.send_signal(ServerMessage::TracksAvailable {
                            audio: false,
                            video: false,
                            screen: false,
                        });
                    }
                    return;
                }
            }

            if room.subscribers.remove(peer_id).is_some() {
                self.metrics.dec_subscribers();
                info!("[Room {}] Subscriber ({}) disconnected", room_id, peer_id);
            }
        }
    }
}
