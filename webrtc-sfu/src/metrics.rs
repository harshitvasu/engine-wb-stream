use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct Metrics {
    pub active_rooms: AtomicU64,
    pub active_publishers: AtomicU64,
    pub active_subscribers: AtomicU64,
    pub audio_frames_forwarded: AtomicU64,
    pub video_frames_forwarded: AtomicU64,
    pub keyframe_requests: AtomicU64,
    pub udp_packets_received: AtomicU64,
    #[allow(dead_code)]
    pub udp_packets_sent: AtomicU64,
    pub errors: AtomicU64,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn inc_rooms(&self) {
        self.active_rooms.fetch_add(1, Ordering::Relaxed);
    }

    #[allow(dead_code)]
    pub fn dec_rooms(&self) {
        self.active_rooms.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn inc_publishers(&self) {
        self.active_publishers.fetch_add(1, Ordering::Relaxed);
    }

    pub fn dec_publishers(&self) {
        self.active_publishers.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn inc_subscribers(&self) {
        self.active_subscribers.fetch_add(1, Ordering::Relaxed);
    }

    pub fn dec_subscribers(&self) {
        self.active_subscribers.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn inc_audio_frames(&self) {
        self.audio_frames_forwarded.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_video_frames(&self) {
        self.video_frames_forwarded.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_keyframe_requests(&self) {
        self.keyframe_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_udp_recv(&self) {
        self.udp_packets_received.fetch_add(1, Ordering::Relaxed);
    }

    #[allow(dead_code)]
    pub fn inc_udp_sent(&self) {
        self.udp_packets_sent.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_errors(&self) {
        self.errors.fetch_add(1, Ordering::Relaxed);
    }
}
