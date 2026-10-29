use std::collections::HashMap;
use str0m::media::{MediaData, Mid};
use str0m::net::Transmit;
use tracing::{debug, error, info, warn};

use crate::metrics::Metrics;
use crate::peer::PeerSession;

fn describe_nalu(data: &[u8]) -> String {
    if data.is_empty() {
        return "empty".to_string();
    }
    let b0 = data[0];
    let nalu_type = b0 & 0x1F;
    match nalu_type {
        1 => "P/B-slice(1)".to_string(),
        5 => "IDR-keyframe(5)".to_string(),
        6 => "SEI(6)".to_string(),
        7 => "SPS(7)".to_string(),
        8 => "PPS(8)".to_string(),
        24 => "STAP-A(24)".to_string(),
        28 => {
            if data.len() > 1 {
                let b1 = data[1];
                let inner_type = b1 & 0x1F;
                let start = (b1 & 0x80) != 0;
                let end = (b1 & 0x40) != 0;
                let inner_desc = match inner_type {
                    1 => "slice(1)",
                    5 => "IDR(5)",
                    7 => "SPS(7)",
                    8 => "PPS(8)",
                    _ => "other",
                };
                format!(
                    "FU-A(28)->{}({}){}{}",
                    inner_desc,
                    inner_type,
                    if start { "[START]" } else { "" },
                    if end { "[END]" } else { "" }
                )
            } else {
                "FU-A(28)".to_string()
            }
        }
        other => format!("NALU({})", other),
    }
}

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
                // Collect valid negotiated payload parameters for this subscriber.
                // IMPORTANT: In str0m, `writer.match_params()` matches against the global session
                // codec config, which can return a PT never negotiated with this subscriber (e.g. PT 127
                // for 42001f when subscriber only negotiated 42e01f on PT 98).
                // We MUST ensure target_pt is strictly one of this subscriber's negotiated PTs.
                let valid_params: Vec<_> = writer.payload_params().collect();

                // 1. Try finding an exact match among negotiated params (codec, profile-level-id, packetization-mode)
                let exact_match = valid_params.iter().find(|p| {
                    p.spec().codec == frame.params.spec().codec
                        && p.spec().format.profile_level_id == frame.params.spec().format.profile_level_id
                        && p.spec().format.packetization_mode == frame.params.spec().format.packetization_mode
                }).map(|p| p.pt());

                // 2. Try matching codec and packetization-mode (e.g. pub 42001f mode 1 -> sub 42e01f mode 1)
                let mode_match = valid_params.iter().find(|p| {
                    p.spec().codec == frame.params.spec().codec
                        && p.spec().format.packetization_mode == frame.params.spec().format.packetization_mode
                }).map(|p| p.pt());

                // 3. Fallback to any negotiated parameter with the same codec (e.g. H.264)
                let codec_match = valid_params.iter().find(|p| {
                    p.spec().codec == frame.params.spec().codec
                }).map(|p| p.pt());

                // 4. Fallback to first negotiated parameter on this writer
                let first_pt = valid_params.first().map(|p| p.pt());

                // 5. Final fallback (only if valid_params is empty)
                let target_pt = exact_match
                    .or(mode_match)
                    .or(codec_match)
                    .or(first_pt)
                    .unwrap_or(frame.pt);

                let is_exact = exact_match.is_some();

                if !is_exact {
                    let available_params: Vec<String> = valid_params
                        .iter()
                        .map(|p| {
                            format!(
                                "PT {} ({:?}, profile: {:?}, mode: {:?})",
                                p.pt(),
                                p.spec().codec,
                                p.spec().format.profile_level_id.map(|v| format!("{:06x}", v)),
                                p.spec().format.packetization_mode
                            )
                        })
                        .collect();
                    warn!(
                        "[SFU-Codec-Mismatch] Sub {} NO EXACT MATCH for pub params (PT {}, {:?}, profile: {:?}, mode: {:?})! Sub negotiated: [{}], translated target_pt: {}",
                        sub_id,
                        frame.pt,
                        frame.params.spec().codec,
                        frame.params.spec().format.profile_level_id.map(|v| format!("{:06x}", v)),
                        frame.params.spec().format.packetization_mode,
                        available_params.join(", "),
                        target_pt
                    );
                }

                if let Err(e) = writer.write(target_pt, frame.network_time, frame.time, frame.data.clone()) {
                    metrics.inc_errors();
                    error!(
                        "[SFU-Media-Write-Error] [Sub {}] Failed to write frame with pt {:?} (pub_pt: {}, nalu: {}): {:?}",
                        sub_id,
                        target_pt,
                        frame.pt,
                        describe_nalu(&frame.data),
                        e
                    );
                } else {
                    let match_str = if is_exact { "YES" } else { "TRANSLATED" };
                    if is_audio {
                        sub.stats.audio_frames_out += 1;
                        if sub.stats.audio_frames_out == 1 || sub.stats.audio_frames_out % 300 == 0 {
                            info!(
                                "[SFU-Media] Sub {} [audio] frame #{} | pt: {}->{} (matched: {}) | len: {} B",
                                sub_id, sub.stats.audio_frames_out, frame.pt, target_pt, match_str, frame.data.len()
                            );
                        }
                    } else if is_video {
                        sub.stats.video_frames_out += 1;
                        let nalu_info = describe_nalu(&frame.data);
                        let is_keyframe = nalu_info.contains("IDR") || nalu_info.contains("SPS") || nalu_info.contains("PPS");
                        if is_keyframe || sub.stats.video_frames_out <= 5 || sub.stats.video_frames_out % 150 == 0 || !is_exact {
                            info!(
                                "[SFU-Media] Sub {} [camera] frame #{} | pt: {}->{} (matched: {}) | nalu: {} | len: {} B",
                                sub_id,
                                sub.stats.video_frames_out,
                                frame.pt,
                                target_pt,
                                match_str,
                                nalu_info,
                                frame.data.len()
                            );
                        }
                    } else {
                        sub.stats.screen_frames_out += 1;
                        let nalu_info = describe_nalu(&frame.data);
                        let is_keyframe = nalu_info.contains("IDR") || nalu_info.contains("SPS") || nalu_info.contains("PPS");
                        if is_keyframe || sub.stats.screen_frames_out <= 5 || sub.stats.screen_frames_out % 150 == 0 || !is_exact {
                            info!(
                                "[SFU-Media] Sub {} [screen] frame #{} | pt: {}->{} (matched: {}) | nalu: {} | len: {} B",
                                sub_id,
                                sub.stats.screen_frames_out,
                                frame.pt,
                                target_pt,
                                match_str,
                                nalu_info,
                                frame.data.len()
                            );
                        }
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
        // Server with prioritized 42e01f
        let mut server_builder = Rtc::builder()
            .clear_codecs()
            .enable_opus(true, false);
        server_builder.codec_config().add_h264(108.into(), Some(109.into()), true, 0x42e01f);
        server_builder.codec_config().add_h264(127.into(), Some(121.into()), true, 0x42001f);
        let mut server = server_builder.build(now);

        // Client offering ONLY H.264 42e01f at PT 98 (identical to iPad / iOS Safari)
        let mut ipad_builder = Rtc::builder()
            .clear_codecs()
            .enable_opus(true, false);
        ipad_builder.codec_config().add_h264(98.into(), None, true, 0x42e01f);
        let mut ipad = ipad_builder.build(now);

        let mut change = ipad.sdp_api();
        let s_mid = change.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None);
        let (offer, pending) = change.apply().unwrap();
        let answer = server.sdp_api().accept_offer(offer).unwrap();
        ipad.sdp_api().accept_answer(pending, answer).unwrap();

        let chrome_params = server.codec_config().find(|p| p.pt() == 127.into()).unwrap().clone();
        // Check writer on server for s_mid
        let writer = server.writer(s_mid).unwrap();
        let valid_pts: Vec<_> = writer.payload_params().map(|p| p.pt()).collect();
        println!("iPad negotiated PTs on server: {:?}", valid_pts);
        assert_eq!(valid_pts, vec![98.into()]);

        // When publisher sends PT 127 (42001f), resolve target_pt strictly against iPad's valid_params
        let valid_params: Vec<_> = writer.payload_params().collect();
        let exact_match = valid_params.iter().find(|p| {
            p.spec().codec == chrome_params.spec().codec
                && p.spec().format.profile_level_id == chrome_params.spec().format.profile_level_id
                && p.spec().format.packetization_mode == chrome_params.spec().format.packetization_mode
        }).map(|p| p.pt());
        let mode_match = valid_params.iter().find(|p| {
            p.spec().codec == chrome_params.spec().codec
                && p.spec().format.packetization_mode == chrome_params.spec().format.packetization_mode
        }).map(|p| p.pt());
        let codec_match = valid_params.iter().find(|p| {
            p.spec().codec == chrome_params.spec().codec
        }).map(|p| p.pt());
        let first_pt = valid_params.first().map(|p| p.pt());

        let target_pt = exact_match
            .or(mode_match)
            .or(codec_match)
            .or(first_pt)
            .unwrap_or(chrome_params.pt());

        println!("Resolved target PT for iPad when publisher sends 42001f: {:?}", target_pt);
        assert_eq!(target_pt, 98.into(), "Target PT must be translated to iPad's negotiated PT 98, never unnegotiated 127");
        assert!(valid_pts.contains(&target_pt), "Target PT must be present in iPad's negotiated PTs");
    }
}
