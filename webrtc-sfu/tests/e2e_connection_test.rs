use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use str0m::change::{SdpAnswer, SdpOffer};
use str0m::media::{Direction, Frequency, MediaKind, MediaTime};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

#[tokio::test]
async fn test_minimal_webrtc_connection() -> Result<(), Box<dyn std::error::Error>> {
    let udp_socket = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
    let sfu_udp_addr = udp_socket.local_addr()?;

    let ws_listener = TcpListener::bind("127.0.0.1:0").await?;
    let sfu_ws_addr = ws_listener.local_addr()?;

    let server_rtc = Arc::new(Mutex::new({
        let now = Instant::now();
        let mut rtc = Rtc::builder().build(now);
        let cand = Candidate::host(sfu_udp_addr, Protocol::Udp)?;
        rtc.add_local_candidate(cand);
        rtc
    }));

    // Server UDP loop
    {
        let socket = udp_socket.clone();
        let rtc_clone = server_rtc.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            loop {
                if let Ok((n, source)) = socket.recv_from(&mut buf).await {
                    let contents = match buf[..n].try_into() {
                        Ok(c) => c,
                        Err(_) => continue,
                    };
                    let input = Input::Receive(
                        Instant::now(),
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: sfu_udp_addr,
                            contents,
                        },
                    );
                    let mut rtc = rtc_clone.lock().await;
                    if rtc.accepts(&input) {
                        let _ = rtc.handle_input(input);
                        while let Ok(out) = rtc.poll_output() {
                            match out {
                                Output::Transmit(t) => {
                                    let _ = socket.send_to(&t.contents, t.destination).await;
                                }
                                Output::Timeout(_) => break,
                                _ => {}
                            }
                        }
                    }
                }
            }
        });
    }

    // Server timeout tick loop
    {
        let socket = udp_socket.clone();
        let rtc_clone = server_rtc.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(10));
            loop {
                interval.tick().await;
                let now = Instant::now();
                let mut rtc = rtc_clone.lock().await;
                let _ = rtc.handle_input(Input::Timeout(now));
                while let Ok(out) = rtc.poll_output() {
                    match out {
                        Output::Transmit(t) => {
                            let _ = socket.send_to(&t.contents, t.destination).await;
                        }
                        Output::Timeout(_) => break,
                        _ => {}
                    }
                }
            }
        });
    }

    // Server WS accept loop
    {
        let rtc_clone = server_rtc.clone();
        let socket = udp_socket.clone();
        tokio::spawn(async move {
            if let Ok((stream, _)) = ws_listener.accept().await {
                let ws_stream = tokio_tungstenite::accept_async(stream).await.unwrap();
                let (mut ws_tx, mut ws_rx) = ws_stream.split();
                while let Some(Ok(Message::Text(text))) = ws_rx.next().await {
                    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
                    if v["type"] == "offer" {
                        let offer_sdp = v["sdp"].as_str().unwrap();
                        let parsed = SdpOffer::from_sdp_string(offer_sdp).unwrap();
                        let mut rtc = rtc_clone.lock().await;
                        let answer = rtc.sdp_api().accept_offer(parsed).unwrap();
                        let answer_sdp = answer.to_sdp_string();
                        let resp = serde_json::json!({
                            "type": "answer",
                            "sdp": answer_sdp,
                            "peerId": v["peerId"]
                        });
                        ws_tx.send(Message::Text(resp.to_string().into())).await.unwrap();
                        while let Ok(out) = rtc.poll_output() {
                            match out {
                                Output::Transmit(t) => {
                                    let _ = socket.send_to(&t.contents, t.destination).await;
                                }
                                Output::Timeout(_) => break,
                                _ => {}
                            }
                        }
                    }
                }
            }
        });
    }

    // Client peer setup
    let client_udp = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
    let client_udp_addr = client_udp.local_addr()?;

    let client_rtc = Arc::new(Mutex::new({
        let now = Instant::now();
        let mut rtc = Rtc::builder().build(now);
        let cand = Candidate::host(client_udp_addr, Protocol::Udp)?;
        rtc.add_local_candidate(cand);
        rtc
    }));

    // Client UDP loop
    {
        let socket = client_udp.clone();
        let rtc_clone = client_rtc.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            loop {
                if let Ok((n, source)) = socket.recv_from(&mut buf).await {
                    let contents = match buf[..n].try_into() {
                        Ok(c) => c,
                        Err(_) => continue,
                    };
                    let input = Input::Receive(
                        Instant::now(),
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: client_udp_addr,
                            contents,
                        },
                    );
                    let mut rtc = rtc_clone.lock().await;
                    if rtc.accepts(&input) {
                        let _ = rtc.handle_input(input);
                        while let Ok(out) = rtc.poll_output() {
                            match out {
                                Output::Transmit(t) => {
                                    let _ = socket.send_to(&t.contents, t.destination).await;
                                }
                                Output::Timeout(_) => break,
                                _ => {}
                            }
                        }
                    }
                }
            }
        });
    }

    // Client timeout tick loop
    {
        let socket = client_udp.clone();
        let rtc_clone = client_rtc.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(10));
            loop {
                interval.tick().await;
                let now = Instant::now();
                let mut rtc = rtc_clone.lock().await;
                let _ = rtc.handle_input(Input::Timeout(now));
                while let Ok(out) = rtc.poll_output() {
                    match out {
                        Output::Transmit(t) => {
                            let _ = socket.send_to(&t.contents, t.destination).await;
                        }
                        Output::Timeout(_) => break,
                        _ => {}
                    }
                }
            }
        });
    }

    // Client creates SDP offer
    let (offer_sdp, pending_offer) = {
        let mut rtc = client_rtc.lock().await;
        let mut change = rtc.sdp_api();
        change.add_media(MediaKind::Audio, Direction::SendOnly, None, None, None);
        change.add_media(MediaKind::Video, Direction::SendOnly, None, None, None);
        let (offer, pending) = change.apply().unwrap();
        (offer.to_sdp_string(), pending)
    };

    // Client connects to SFU WebSocket
    let ws_url = format!("ws://{}", sfu_ws_addr);
    let (ws_stream, _) = connect_async(&ws_url).await?;
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    let offer_msg = serde_json::json!({
        "type": "offer",
        "peerId": "client-1",
        "sdp": offer_sdp
    });
    ws_tx.send(Message::Text(offer_msg.to_string().into())).await?;

    let answer_msg = ws_rx.next().await.unwrap()?;
    let answer_json: serde_json::Value = serde_json::from_str(&answer_msg.to_string())?;
    assert_eq!(answer_json["type"], "answer");
    let answer_sdp = answer_json["sdp"].as_str().unwrap();

    {
        let mut rtc = client_rtc.lock().await;
        let parsed_answer = SdpAnswer::from_sdp_string(answer_sdp).unwrap();
        rtc.sdp_api().accept_answer(pending_offer, parsed_answer).unwrap();
        while let Ok(out) = rtc.poll_output() {
            match out {
                Output::Transmit(t) => {
                    let _ = client_udp.send_to(&t.contents, t.destination).await;
                }
                Output::Timeout(_) => break,
                _ => {}
            }
        }
    }

    // Wait for ICE & DTLS establishment
    let start = Instant::now();
    let mut client_connected = false;
    let mut server_connected = false;

    while start.elapsed() < Duration::from_secs(5) {
        {
            let rtc = client_rtc.lock().await;
            if rtc.is_connected() {
                client_connected = true;
            }
        }
        {
            let rtc = server_rtc.lock().await;
            if rtc.is_connected() {
                server_connected = true;
            }
        }
        if client_connected && server_connected {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    assert!(client_connected, "Client WebRTC connection failed to establish!");
    assert!(server_connected, "Server WebRTC connection failed to establish!");
    println!("✓ Phase 2 Verified: Real WebRTC connection, ICE, and DTLS-SRTP established successfully!");

    Ok(())
}

// =========================================================================
// PHASE 3, 4, 5: AUDIO + VIDEO ONE-TO-MANY FORWARDING TEST
// =========================================================================

struct SimulatedClient {
    #[allow(dead_code)]
    pub peer_id: String,
    pub udp_socket: Arc<UdpSocket>,
    pub rtc: Arc<Mutex<Rtc>>,
    pub audio_mid: Option<str0m::media::Mid>,
    pub video_mid: Option<str0m::media::Mid>,
    pub received_audio_frames: Arc<Mutex<Vec<Vec<u8>>>>,
    pub received_video_frames: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl SimulatedClient {
    pub async fn new(
        peer_id: String,
        sfu_ws_addr: std::net::SocketAddr,
        role: &str,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let udp_socket = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
        let client_udp_addr = udp_socket.local_addr()?;

        let rtc = Arc::new(Mutex::new({
            let now = Instant::now();
            let mut r = Rtc::builder().build(now);
            let cand = Candidate::host(client_udp_addr, Protocol::Udp)?;
            r.add_local_candidate(cand);
            r
        }));

        let received_audio_frames = Arc::new(Mutex::new(Vec::new()));
        let received_video_frames = Arc::new(Mutex::new(Vec::new()));

        let (offer_sdp, pending_offer, audio_mid, video_mid) = {
            let mut r = rtc.lock().await;
            let mut change = r.sdp_api();
            let dir = if role == "publisher" {
                Direction::SendOnly
            } else {
                Direction::RecvOnly
            };
            let a_mid = change.add_media(MediaKind::Audio, dir, None, None, None);
            let v_mid = change.add_media(MediaKind::Video, dir, None, None, None);
            let (offer, pending) = change.apply().unwrap();
            (offer.to_sdp_string(), pending, a_mid, v_mid)
        };

        // UDP loop
        {
            let socket = udp_socket.clone();
            let rtc_clone = rtc.clone();
            let audio_recv = received_audio_frames.clone();
            let video_recv = received_video_frames.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 2048];
                loop {
                    if let Ok((n, source)) = socket.recv_from(&mut buf).await {
                        let contents = match buf[..n].try_into() {
                            Ok(c) => c,
                            Err(_) => continue,
                        };
                        let input = Input::Receive(
                            Instant::now(),
                            Receive {
                                proto: Protocol::Udp,
                                source,
                                destination: client_udp_addr,
                                contents,
                            },
                        );
                        let mut r = rtc_clone.lock().await;
                        if r.accepts(&input) {
                            let _ = r.handle_input(input);
                            while let Ok(out) = r.poll_output() {
                                match out {
                                    Output::Transmit(t) => {
                                        let _ = socket.send_to(&t.contents, t.destination).await;
                                    }
                                    Output::Event(Event::MediaData(data)) => {
                                        if data.mid == audio_mid {
                                            audio_recv.lock().await.push(data.data.to_vec());
                                        } else if data.mid == video_mid {
                                            video_recv.lock().await.push(data.data.to_vec());
                                        }
                                    }
                                    Output::Timeout(_) => break,
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            });
        }

        // Timeout tick loop
        {
            let socket = udp_socket.clone();
            let rtc_clone = rtc.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(10));
                loop {
                    interval.tick().await;
                    let now = Instant::now();
                    let mut r = rtc_clone.lock().await;
                    let _ = r.handle_input(Input::Timeout(now));
                    while let Ok(out) = r.poll_output() {
                        match out {
                            Output::Transmit(t) => {
                                let _ = socket.send_to(&t.contents, t.destination).await;
                            }
                            Output::Timeout(_) => break,
                            _ => {}
                        }
                    }
                }
            });
        }

        // WebSocket join & offer/answer
        let ws_url = format!("ws://{}", sfu_ws_addr);
        let (ws_stream, _) = connect_async(&ws_url).await?;
        let (mut ws_tx, mut ws_rx) = ws_stream.split();

        let join_msg = serde_json::json!({
            "type": "join",
            "roomId": "test-room",
            "role": role,
            "peerId": peer_id
        });
        ws_tx.send(Message::Text(join_msg.to_string().into())).await?;

        // Read until joined
        while let Some(Ok(Message::Text(txt))) = ws_rx.next().await {
            let v: serde_json::Value = serde_json::from_str(&txt)?;
            if v["type"] == "joined" {
                break;
            }
        }

        // Send offer
        let offer_msg = serde_json::json!({
            "type": "offer",
            "peerId": peer_id,
            "sdp": offer_sdp
        });
        ws_tx.send(Message::Text(offer_msg.to_string().into())).await?;

        // Read until answer
        while let Some(Ok(Message::Text(txt))) = ws_rx.next().await {
            let v: serde_json::Value = serde_json::from_str(&txt)?;
            if v["type"] == "answer" {
                let answer_sdp = v["sdp"].as_str().unwrap();
                let mut r = rtc.lock().await;
                let parsed_answer = SdpAnswer::from_sdp_string(answer_sdp).unwrap();
                r.sdp_api().accept_answer(pending_offer, parsed_answer).unwrap();
                while let Ok(out) = r.poll_output() {
                    match out {
                        Output::Transmit(t) => {
                            let _ = udp_socket.send_to(&t.contents, t.destination).await;
                        }
                        Output::Timeout(_) => break,
                        _ => {}
                    }
                }
                break;
            }
        }

        Ok(Self {
            peer_id,
            udp_socket,
            rtc,
            audio_mid: Some(audio_mid),
            video_mid: Some(video_mid),
            received_audio_frames,
            received_video_frames,
        })
    }

    pub async fn wait_connected(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            {
                let r = self.rtc.lock().await;
                if r.is_connected() {
                    return true;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }
}

#[tokio::test]
async fn test_audio_and_video_forwarding_one_to_many() -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Starting Phase 3, 4, 5 WebRTC Multi-Subscriber Audio & Video Forwarding Test ===");

    // Bind server UDP socket
    let sfu_udp = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
    let sfu_udp_addr = sfu_udp.local_addr()?;

    // Bind server WS
    let sfu_ws = TcpListener::bind("127.0.0.1:0").await?;
    let sfu_ws_addr = sfu_ws.local_addr()?;

    let config = webrtc_sfu::config::Config {
        signaling_host: "127.0.0.1".parse()?,
        signaling_port: sfu_ws_addr.port(),
        udp_bind_host: "127.0.0.1".parse()?,
        udp_port: sfu_udp_addr.port(),
        public_ip: "127.0.0.1".parse()?,
        lan_ip: None,
    };

    let metrics = Arc::new(webrtc_sfu::metrics::Metrics::new());
    let room_manager = Arc::new(Mutex::new(webrtc_sfu::rooms::RoomManager::new(
        config,
        metrics.clone(),
    )));

    // Server UDP receive loop
    {
        let socket = sfu_udp.clone();
        let manager = room_manager.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            loop {
                if let Ok((n, source)) = socket.recv_from(&mut buf).await {
                    let mut transmits = Vec::new();
                    {
                        let mut mgr = manager.lock().await;
                        mgr.handle_udp_packet(source, &buf[..n], &mut transmits);
                    }
                    for t in transmits {
                        let _ = socket.send_to(&t.contents, t.destination).await;
                    }
                }
            }
        });
    }

    // Server timeout tick loop
    {
        let socket = sfu_udp.clone();
        let manager = room_manager.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(10));
            loop {
                interval.tick().await;
                let now = Instant::now();
                let mut transmits = Vec::new();
                {
                    let mut mgr = manager.lock().await;
                    mgr.handle_timeout_tick(now, &mut transmits);
                }
                for t in transmits {
                    let _ = socket.send_to(&t.contents, t.destination).await;
                }
            }
        });
    }

    // Server WS accept loop
    {
        let manager = room_manager.clone();
        let socket = sfu_udp.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = sfu_ws.accept().await {
                let ws_stream = tokio_tungstenite::accept_async(stream).await.unwrap();
                let (mut ws_tx, mut ws_rx) = ws_stream.split();
                let (tx, mut rx) = mpsc::unbounded_channel::<webrtc_sfu::signaling::ServerMessage>();

                tokio::spawn(async move {
                    while let Some(msg) = rx.recv().await {
                        if let Ok(json) = serde_json::to_string(&msg) {
                            let _ = ws_tx.send(Message::Text(json.into())).await;
                        }
                    }
                });

                let mgr = manager.clone();
                let sock = socket.clone();
                tokio::spawn(async move {
                    while let Some(Ok(Message::Text(text))) = ws_rx.next().await {
                        let msg: webrtc_sfu::signaling::ClientMessage =
                            serde_json::from_str(&text).unwrap();
                        match msg {
                            webrtc_sfu::signaling::ClientMessage::Join {
                                room_id,
                                role,
                                peer_id,
                            } => {
                                let mut m = mgr.lock().await;
                                let res = m.join(room_id.clone(), &role, peer_id.clone(), Some(tx.clone())).unwrap();
                                let _ = tx.send(webrtc_sfu::signaling::ServerMessage::Joined {
                                    room_id,
                                    peer_id,
                                    role: res.as_str().to_string(),
                                });
                            }
                            webrtc_sfu::signaling::ClientMessage::Offer { sdp, peer_id, tracks } => {
                                let (answer_sdp, transmits) = {
                                    let mut m = mgr.lock().await;
                                    m.handle_offer("test-room", &peer_id, &sdp, tracks.as_ref()).unwrap()
                                };
                                let _ = tx.send(webrtc_sfu::signaling::ServerMessage::Answer {
                                    sdp: answer_sdp,
                                    peer_id,
                                });
                                for t in transmits {
                                    let _ = sock.send_to(&t.contents, t.destination).await;
                                }
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
    }

    // 1. Connect Publisher
    println!("Connecting Publisher...");
    let publisher = SimulatedClient::new("pub-1".into(), sfu_ws_addr, "publisher").await?;
    assert!(publisher.wait_connected(Duration::from_secs(5)).await, "Publisher connection failed");
    println!("✓ Publisher connected and DTLS established!");

    // 2. Connect Subscriber 1
    println!("Connecting Subscriber 1...");
    let sub1 = SimulatedClient::new("sub-1".into(), sfu_ws_addr, "subscriber").await?;
    assert!(sub1.wait_connected(Duration::from_secs(5)).await, "Subscriber 1 connection failed");
    println!("✓ Subscriber 1 connected and DTLS established!");

    // 3. Connect Subscriber 2
    println!("Connecting Subscriber 2...");
    let sub2 = SimulatedClient::new("sub-2".into(), sfu_ws_addr, "subscriber").await?;
    assert!(sub2.wait_connected(Duration::from_secs(5)).await, "Subscriber 2 connection failed");
    println!("✓ Subscriber 2 connected and DTLS established!");

    // 4. Publisher sends Opus Audio Frame
    println!("\nBroadcasting Opus Audio Frame from Publisher...");
    let audio_payload = vec![0xf8, 0xff, 0xfe, 0x11, 0x22, 0x33]; // sample Opus packet
    {
        let mut r = publisher.rtc.lock().await;
        let mid = publisher.audio_mid.unwrap();
        let params = r.codec_config().find(|p| p.spec().codec == str0m::format::Codec::Opus).unwrap().clone();
        let writer = r.writer(mid).expect("Publisher must have audio writer");
        let pt = writer.match_params(params).unwrap();
        writer.write(pt, Instant::now(), MediaTime::new(4800, Frequency::FORTY_EIGHT_KHZ), audio_payload.clone()).unwrap();
        while let Ok(out) = r.poll_output() {
            match out {
                Output::Transmit(t) => {
                    let _ = publisher.udp_socket.send_to(&t.contents, t.destination).await;
                }
                Output::Timeout(_) => break,
                _ => {}
            }
        }
    }

    // Wait and verify both subscribers receive the audio packet
    tokio::time::sleep(Duration::from_millis(200)).await;
    let s1_audio = sub1.received_audio_frames.lock().await.clone();
    let s2_audio = sub2.received_audio_frames.lock().await.clone();

    println!("Subscriber 1 received audio frames: {}", s1_audio.len());
    println!("Subscriber 2 received audio frames: {}", s2_audio.len());
    assert!(!s1_audio.is_empty(), "Subscriber 1 did not receive forwarded audio!");
    assert!(!s2_audio.is_empty(), "Subscriber 2 did not receive forwarded audio!");
    assert_eq!(s1_audio[0], audio_payload);
    assert_eq!(s2_audio[0], audio_payload);
    println!("✓ Phase 3 & 4 Verified: Audio successfully published and forwarded to 2 simultaneous subscribers!");

    // 5. Publisher sends H.264 Video Frame
    println!("\nBroadcasting H.264 Video Frame from Publisher...");
    let video_payload = vec![0x05, 0x04, 0x05, 0x06, 0x07, 0x08]; 
    {
        let mut r = publisher.rtc.lock().await;
        let mid = publisher.video_mid.unwrap();
        let params = r.codec_config().find(|p| p.spec().codec == str0m::format::Codec::H264).unwrap().clone();
        let writer = r.writer(mid).expect("Publisher must have video writer");
        let pt = writer.match_params(params).unwrap();
        writer.write(pt, Instant::now(), MediaTime::new(9000, Frequency::NINETY_KHZ), video_payload.clone()).unwrap();
        while let Ok(out) = r.poll_output() {
            match out {
                Output::Transmit(t) => {
                    let _ = publisher.udp_socket.send_to(&t.contents, t.destination).await;
                }
                Output::Timeout(_) => break,
                _ => {}
            }
        }
    }

    // Wait and verify both subscribers receive the video packet
    tokio::time::sleep(Duration::from_millis(200)).await;
    let s1_video = sub1.received_video_frames.lock().await.clone();
    let s2_video = sub2.received_video_frames.lock().await.clone();

    println!("Subscriber 1 received video frames: {}", s1_video.len());
    println!("Subscriber 2 received video frames: {}", s2_video.len());
    assert!(!s1_video.is_empty(), "Subscriber 1 did not receive forwarded video!");
    assert!(!s2_video.is_empty(), "Subscriber 2 did not receive forwarded video!");
    let expected_annex_b = vec![0x00, 0x00, 0x00, 0x01, 0x05, 0x04, 0x05, 0x06, 0x07, 0x08];
    assert_eq!(s1_video[0], expected_annex_b);
    assert_eq!(s2_video[0], expected_annex_b);
    println!("✓ Phase 5 Verified: Video thumbnail frame successfully published and forwarded to 2 simultaneous subscribers!");

    Ok(())
}
