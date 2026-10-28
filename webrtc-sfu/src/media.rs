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
                let target_pt = writer
                    .match_params(frame.params)
                    .or_else(|| {
                        writer
                            .payload_params()
                            .find(|p| p.spec().codec == frame.params.spec().codec)
                            .map(|p| p.pt())
                    })
                    .or_else(|| writer.payload_params().next().map(|p| p.pt()))
                    .unwrap_or(frame.pt);

                if let Err(e) = writer.write(target_pt, frame.network_time, frame.time, frame.data.clone()) {
                    metrics.inc_errors();
                    debug!("[Sub {}] Failed to write frame with pt {:?}: {:?}", sub_id, target_pt, e);
                } else {
                    if is_audio {
                        sub.stats.audio_frames_out += 1;
                    } else if is_video {
                        sub.stats.video_frames_out += 1;
                    } else {
                        sub.stats.screen_frames_out += 1;
                    }
                    sub.stats.last_frame_time = Some(std::time::Instant::now());

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

    #[test]
    fn test_cross_profile_pt_matching() {
        use str0m::media::{Direction, MediaKind};
        use str0m::Rtc;
        use std::time::Instant;

        let now = Instant::now();
        // Server
        let mut server = Rtc::builder()
            .clear_codecs()
            .enable_opus(true, false)
            .enable_h264(true)
            .build(now);

        // Client offering H264 (like Safari)
        let mut safari = Rtc::builder()
            .clear_codecs()
            .enable_opus(true, false)
            .enable_h264(true)
            .build(now);

        let mut change = safari.sdp_api();
        let s_mid = change.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None);
        let (offer, pending) = change.apply().unwrap();
        let answer = server.sdp_api().accept_offer(offer).unwrap();
        safari.sdp_api().accept_answer(pending, answer).unwrap();

        let chrome_params = server.codec_config().find(|p| p.pt() == 127.into()).unwrap().clone();
        // Check writer on server for s_mid
        let writer = server.writer(s_mid).unwrap();
        let valid_pts: Vec<_> = writer.payload_params().map(|p| p.pt()).collect();
        println!("Safari negotiated PTs on server: {:?}", valid_pts);

        let matched = writer.match_params(chrome_params.clone());
        println!("writer.match_params for PT 127 returned: {:?}", matched);

        // Test writing with matched or fallback PT
        let target_pt = writer
            .match_params(chrome_params.clone())
            .or_else(|| {
                writer
                    .payload_params()
                    .find(|p| p.spec().codec == chrome_params.spec().codec)
                    .map(|p| p.pt())
            })
            .or_else(|| writer.payload_params().next().map(|p| p.pt()))
            .unwrap_or(chrome_params.pt());

        println!("Resolved target PT for Safari: {:?}", target_pt);
        assert!(valid_pts.contains(&target_pt), "Target PT must be valid on Safari transceiver");
    }
}
