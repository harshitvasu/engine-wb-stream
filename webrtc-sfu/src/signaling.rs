use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidatePayload {
    pub candidate: String,
    #[serde(default)]
    pub sdp_mid: Option<String>,
    #[serde(default)]
    pub sdp_m_line_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackMapping {
    #[serde(default)]
    pub audio_mid: Option<String>,
    #[serde(default)]
    pub video_mid: Option<String>,
    #[serde(default)]
    pub screen_mid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Join {
        #[serde(rename = "roomId")]
        room_id: String,
        role: String, // "publisher" | "subscriber"
        #[serde(rename = "peerId")]
        peer_id: String,
    },
    Offer {
        sdp: String,
        #[serde(rename = "peerId")]
        peer_id: String,
        #[serde(default)]
        tracks: Option<TrackMapping>,
    },
    Answer {
        sdp: String,
        #[serde(rename = "peerId")]
        peer_id: String,
    },
    Candidate {
        #[serde(rename = "peerId")]
        peer_id: String,
        candidate: CandidatePayload,
    },
    RequestKeyframe {
        #[serde(rename = "peerId")]
        peer_id: String,
        #[serde(default)]
        kind: Option<String>, // "video", "screen", "all"
    },
    TracksUpdate {
        #[serde(rename = "peerId")]
        peer_id: String,
        #[serde(default)]
        audio: bool,
        #[serde(default)]
        video: bool,
        #[serde(default)]
        screen: bool,
    },
    Ping,
    Leave {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "peerId")]
        peer_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Joined {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "peerId")]
        peer_id: String,
        role: String,
    },
    Answer {
        sdp: String,
        #[serde(rename = "peerId")]
        peer_id: String,
    },
    Offer {
        sdp: String,
        #[serde(rename = "peerId")]
        peer_id: String,
    },
    Candidate {
        #[serde(rename = "peerId")]
        peer_id: String,
        candidate: CandidatePayload,
    },
    TracksAvailable {
        audio: bool,
        video: bool,
        #[serde(default)]
        screen: bool,
    },
    PeerDisconnected {
        #[serde(rename = "peerId")]
        peer_id: String,
    },
    Error {
        message: String,
    },
    Pong,
}
