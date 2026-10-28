use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use futures::{SinkExt, StreamExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod config;
mod dashboard;
mod media;
mod metrics;
mod peer;
mod rooms;
mod signaling;

use config::Config;
use dashboard::render_dashboard_html;
use metrics::Metrics;
use rooms::RoomManager;
use signaling::{ClientMessage, ServerMessage};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "webrtc_sfu=info,str0m=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env();
    info!("Starting WebRTC SFU Server...");
    info!("Signaling listening on: ws://{}", config.signaling_addr());
    info!("UDP Media Socket binding on: {}", config.udp_bind_addr());
    info!("Advertised Media IP for ICE: {}", config.public_ip);
    if let Some(lan) = config.lan_ip {
        info!("Detected LAN Media IP for Wi-Fi/remote clients: {}:{}", lan, config.udp_port);
    }

    let metrics = Arc::new(Metrics::new());
    let room_manager = Arc::new(Mutex::new(RoomManager::new(config.clone(), metrics.clone())));

    // 1. Bind UDP socket for WebRTC media (SRTP/RTCP/STUN)
    let udp_socket = Arc::new(UdpSocket::bind(config.udp_bind_addr()).await?);

    // 2. Spawn UDP Media Ingestion & Forwarding Loop
    {
        let socket = udp_socket.clone();
        let manager = room_manager.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            loop {
                match socket.recv_from(&mut buf).await {
                    Ok((n, source)) => {
                        let mut transmits = Vec::new();
                        {
                            let mut mgr = manager.lock().await;
                            mgr.handle_udp_packet(source, &buf[..n], &mut transmits);
                        }

                        for t in transmits {
                            if let Err(e) = socket.send_to(&t.contents, t.destination).await {
                                debug!("[UDP Ingress] send_to {} failed: {:?}", t.destination, e);
                            }
                        }
                    }
                    Err(e) => {
                        error!("UDP recv error: {:?}", e);
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
            }
        });
    }

    // 3. Spawn WebRTC Protocol Timer Engine Tick Loop (Every 10ms)
    {
        let socket = udp_socket.clone();
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
                    if let Err(e) = socket.send_to(&t.contents, t.destination).await {
                        debug!("[UDP Timer] send_to {} failed: {:?}", t.destination, e);
                    }
                }
            }
        });
    }

    // 4. Start HTTP & WebSocket Signaling Server
    let start_time = Instant::now();
    let listener = TcpListener::bind(config.signaling_addr()).await?;
    info!("🚀 WebRTC SFU ready and accepting connections!");
    info!("🌐 Public Media IP:    {}", config.public_media_addr());
    if let Some(lan) = config.lan_media_addr() {
        info!("🏠 LAN/VPC Media IP:   {}", lan);
    }
    info!("📊 SFU Live Dashboard: http://{}/dashboard", config.signaling_addr());
    info!("📡 SFU Live JSON API:  http://{}/api/rooms", config.signaling_addr());

    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                let manager = room_manager.clone();
                let socket = udp_socket.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, peer_addr, manager, socket, start_time).await {
                        debug!("Connection handled or closed from {}: {:?}", peer_addr, e);
                    }
                });
            }
            Err(e) => {
                error!("TCP accept error: {:?}", e);
            }
        }
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    peer_addr: SocketAddr,
    manager: Arc<Mutex<RoomManager>>,
    udp_socket: Arc<UdpSocket>,
    start_time: Instant,
) -> Result<()> {
    let mut peek_buf = [0u8; 1024];
    let n = stream.peek(&mut peek_buf).await?;
    let peek_str = String::from_utf8_lossy(&peek_buf[..n]);

    let is_ws = peek_str.to_lowercase().contains("upgrade: websocket");

    if is_ws {
        handle_ws_connection(stream, peer_addr, manager, udp_socket).await
    } else {
        handle_http_connection(stream, peer_addr, manager, start_time).await
    }
}

async fn handle_http_connection(
    mut stream: tokio::net::TcpStream,
    _peer_addr: SocketAddr,
    manager: Arc<Mutex<RoomManager>>,
    start_time: Instant,
) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }

    let req_str = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req_str.lines();
    let req_line = lines.next().unwrap_or("");
    let parts: Vec<&str> = req_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(());
    }

    let method = parts[0];
    let mut path = parts[1];
    if let Some((p, _)) = path.split_once('?') {
        path = p;
    }

    if method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\n\
                    Access-Control-Allow-Origin: *\r\n\
                    Access-Control-Allow-Methods: GET, OPTIONS\r\n\
                    Access-Control-Allow-Headers: *\r\n\
                    Connection: close\r\n\r\n";
        stream.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    if path == "/api/rooms" || path == "/rooms" || path == "/status" || path == "/api/status" {
        let snapshot = {
            let mgr = manager.lock().await;
            mgr.get_status_snapshot(start_time)
        };
        let json = serde_json::to_string_pretty(&snapshot)?;
        let resp = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/json\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n{}",
            json.len(),
            json
        );
        stream.write_all(resp.as_bytes()).await?;
    } else if path == "/dashboard" || path == "/" || path == "/sfu-dashboard" {
        let html = render_dashboard_html();
        let resp = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: text/html; charset=utf-8\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n{}",
            html.len(),
            html
        );
        stream.write_all(resp.as_bytes()).await?;
    } else {
        let body = "Not Found";
        let resp = format!(
            "HTTP/1.1 404 Not Found\r\n\
             Content-Type: text/plain\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(resp.as_bytes()).await?;
    }

    Ok(())
}

async fn handle_ws_connection(
    stream: tokio::net::TcpStream,
    peer_addr: SocketAddr,
    manager: Arc<Mutex<RoomManager>>,
    udp_socket: Arc<UdpSocket>,
) -> Result<()> {
    let ws_stream = accept_async(stream).await?;
    info!("[WS] Established signaling connection from {}", peer_addr);

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();

    // Forward outbound signaling messages to the WebSocket client
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if ws_sender.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    let mut joined_room: Option<String> = None;
    let mut current_peer_id: Option<String> = None;

    while let Some(msg_result) = ws_receiver.next().await {
        let msg = match msg_result {
            Ok(m) => m,
            Err(_) => break,
        };

        if msg.is_close() {
            break;
        }

        if let Message::Ping(_) = &msg {
            let _ = tx.send(ServerMessage::Pong);
            continue;
        }

        if let Message::Text(text) = msg {
            let client_msg: ClientMessage = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(err) => {
                    warn!("Invalid JSON message from {}: {:?} (body: {})", peer_addr, err, text);
                    let _ = tx.send(ServerMessage::Error {
                        message: format!("Malformed message: {}", err),
                    });
                    continue;
                }
            };

            match client_msg {
                ClientMessage::Ping => {
                    let _ = tx.send(ServerMessage::Pong);
                }

                ClientMessage::Join {
                    room_id,
                    role,
                    peer_id,
                } => {
                    joined_room = Some(room_id.clone());
                    current_peer_id = Some(peer_id.clone());

                    let join_result = {
                        let mut mgr = manager.lock().await;
                        mgr.join(room_id.clone(), &role, peer_id.clone(), Some(tx.clone()))
                    };

                    match join_result {
                        Ok(assigned_role) => {
                            let _ = tx.send(ServerMessage::Joined {
                                room_id,
                                peer_id,
                                role: assigned_role.as_str().to_string(),
                            });
                        }
                        Err(e) => {
                            let _ = tx.send(ServerMessage::Error {
                                message: e.to_string(),
                            });
                        }
                    }
                }

                ClientMessage::Offer { sdp, peer_id, tracks } => {
                    let room_id = joined_room.clone().unwrap_or_else(|| "default".to_string());
                    let result = {
                        let mut mgr = manager.lock().await;
                        mgr.handle_offer(&room_id, &peer_id, &sdp, tracks.as_ref())
                    };

                    match result {
                        Ok((answer_sdp, transmits)) => {
                            let _ = tx.send(ServerMessage::Answer {
                                sdp: answer_sdp,
                                peer_id,
                            });
                            for t in transmits {
                                if let Err(e) = udp_socket.send_to(&t.contents, t.destination).await {
                                    debug!("[Offer Answer] send_to {} failed: {:?}", t.destination, e);
                                }
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(ServerMessage::Error {
                                message: format!("Failed to process SDP offer: {}", e),
                            });
                        }
                    }
                }

                ClientMessage::Answer { sdp: _, peer_id: _ } => {
                    // Browser in our flow sends offer, SFU sends answer.
                }

                ClientMessage::Candidate { peer_id, candidate } => {
                    let room_id = joined_room.clone().unwrap_or_else(|| "default".to_string());
                    let transmits = {
                        let mut mgr = manager.lock().await;
                        mgr.handle_candidate(&room_id, &peer_id, &candidate).unwrap_or_default()
                    };
                    for t in transmits {
                        if let Err(e) = udp_socket.send_to(&t.contents, t.destination).await {
                            debug!("[Candidate] send_to {} failed: {:?}", t.destination, e);
                        }
                    }
                }

                ClientMessage::RequestKeyframe { peer_id, kind } => {
                    let room_id = joined_room.clone().unwrap_or_else(|| "default".to_string());
                    let transmits = {
                        let mut mgr = manager.lock().await;
                        mgr.request_keyframe(&room_id, &peer_id, kind.as_deref())
                    };
                    for t in transmits {
                        if let Err(e) = udp_socket.send_to(&t.contents, t.destination).await {
                            debug!("[Keyframe] send_to {} failed: {:?}", t.destination, e);
                        }
                    }
                }

                ClientMessage::TracksUpdate { peer_id, audio, video, screen } => {
                    let room_id = joined_room.clone().unwrap_or_else(|| "default".to_string());
                    let mut mgr = manager.lock().await;
                    mgr.handle_tracks_update(&room_id, &peer_id, audio, video, screen);
                }

                ClientMessage::Leave { room_id, peer_id } => {
                    let mut mgr = manager.lock().await;
                    mgr.leave(&room_id, &peer_id);
                    break;
                }
            }
        }
    }

    // Handle WS disconnect gracefully without tearing down active WebRTC UDP streams
    if let (Some(room_id), Some(peer_id)) = (joined_room, current_peer_id) {
        let mut mgr = manager.lock().await;
        mgr.handle_ws_disconnect(&room_id, &peer_id);
    }

    Ok(())
}
