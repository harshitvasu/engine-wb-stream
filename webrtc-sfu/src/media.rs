use std::collections::HashMap;
use str0m::media::{MediaData, Mid};
use str0m::net::Transmit;
use tracing::debug;

use crate::metrics::Metrics;
use crate::peer::PeerSession;

pub struct MediaRouter;

impl MediaRouter {
    /// Forwards an encoded media frame (Opus audio or VP8 video) from the publisher
    /// to all authorized subscribers in the room.
    pub fn forward_frame(
        frame: &MediaData,
        pub_audio_mid: Option<Mid>,
        pub_video_mid: Option<Mid>,
        subscribers: &mut HashMap<String, PeerSession>,
        metrics: &Metrics,
        transmits: &mut Vec<Transmit>,
    ) {
        let is_audio = Some(frame.mid) == pub_audio_mid;
        let is_video = Some(frame.mid) == pub_video_mid;

        if !is_audio && !is_video {
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
            } else {
                sub.video_mid
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
