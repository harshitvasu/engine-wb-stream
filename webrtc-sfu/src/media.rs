use std::collections::HashMap;
use str0m::media::{MediaData, Mid};
use str0m::net::Transmit;
use tracing::debug;

use crate::metrics::Metrics;
use crate::peer::PeerSession;

pub struct MediaRouter;

impl MediaRouter {
    /// Forwards an encoded media frame (Opus audio, VP8 camera video, or full resolution screen video)
    /// from the publisher to all authorized subscribers in the room.
    pub fn forward_frame(
        frame: &MediaData,
        pub_audio_mid: Option<Mid>,
        pub_video_mid: Option<Mid>,
        pub_screen_mid: Option<Mid>,
        subscribers: &mut HashMap<String, PeerSession>,
        metrics: &Metrics,
        transmits: &mut Vec<Transmit>,
    ) {
        let is_audio = Some(frame.mid) == pub_audio_mid;
        let is_video = Some(frame.mid) == pub_video_mid;
        let is_screen = Some(frame.mid) == pub_screen_mid;

        if !is_audio && !is_video && !is_screen {
            debug!("Received frame with unmapped MID: {}", frame.mid);
            return;
        }

        if is_audio {
            metrics.inc_audio_frames();
        } else {
            metrics.inc_video_frames();
        }

        for (sub_id, sub) in subscribers.iter_mut() {
            let target_mid = if is_audio {
                sub.audio_mid
            } else if is_video {
                sub.video_mid
            } else {
                // For screen video, route to sub.screen_mid if negotiated; fallback to video_mid if sub only has 1 video line
                sub.screen_mid.or(sub.video_mid)
            };

            let Some(target_mid) = target_mid else {
                continue;
            };

            if let Some(writer) = sub.rtc.writer(target_mid) {
                let pt = writer.match_params(frame.params).unwrap_or(frame.pt);
                if let Err(e) = writer.write(pt, frame.network_time, frame.time, frame.data.clone()) {
                    metrics.inc_errors();
                    debug!("[Sub {}] Failed to write frame: {:?}", sub_id, e);
                } else {
                    // Drain subscriber's outputs for any generated transmits
                    let mut dummy_frames = Vec::new();
                    let mut dummy_keyframe = false;
                    sub.drain_outputs(transmits, &mut dummy_frames, &mut dummy_keyframe);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_media_router_classification() {
        let pub_audio = Some(Mid::from("0"));
        let pub_video = Some(Mid::from("1"));
        let pub_screen = Some(Mid::from("2"));

        // Audio frame check
        let is_audio = Some(Mid::from("0")) == pub_audio;
        let is_video = Some(Mid::from("0")) == pub_video;
        let is_screen = Some(Mid::from("0")) == pub_screen;
        assert!(is_audio);
        assert!(!is_video);
        assert!(!is_screen);

        // Video frame check
        let is_audio = Some(Mid::from("1")) == pub_audio;
        let is_video = Some(Mid::from("1")) == pub_video;
        let is_screen = Some(Mid::from("1")) == pub_screen;
        assert!(!is_audio);
        assert!(is_video);
        assert!(!is_screen);

        // Screen frame check
        let is_audio = Some(Mid::from("2")) == pub_audio;
        let is_video = Some(Mid::from("2")) == pub_video;
        let is_screen = Some(Mid::from("2")) == pub_screen;
        assert!(!is_audio);
        assert!(!is_video);
        assert!(is_screen);
    }
}
