use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use futures::{SinkExt, StreamExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod config;
mod media;
mod metrics;
mod peer;
mod rooms;
mod signaling;

use config::Config;
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
                            let _ = socket.send_to(&t.contents, t.destination).await;
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
                    let _ = socket.send_to(&t.contents, t.destination).await;
                }
            }
        });
    }

    // 4. Start WebSocket Signaling Server
    let listener = TcpListener::bind(config.signaling_addr()).await?;
    info!("🚀 WebRTC SFU ready and accepting connections!");

    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                let manager = room_manager.clone();
                let socket = udp_socket.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_ws_connection(stream, peer_addr, manager, socket).await {
                        warn!("WebSocket connection error from {}: {:?}", peer_addr, e);
                    }
                });
            }
            Err(e) => {
                error!("TCP accept error: {:?}", e);
            }
        }
    }
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

                ClientMessage::Offer { sdp, peer_id } => {
                    let room_id = joined_room.clone().unwrap_or_else(|| "default".to_string());
                    let result = {
                        let mut mgr = manager.lock().await;
                        mgr.handle_offer(&room_id, &peer_id, &sdp)
                    };

                    match result {
                        Ok((answer_sdp, transmits)) => {
                            let _ = tx.send(ServerMessage::Answer {
                                sdp: answer_sdp,
                                peer_id,
                            });
                            for t in transmits {
                                let _ = udp_socket.send_to(&t.contents, t.destination).await;
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
                        let _ = udp_socket.send_to(&t.contents, t.destination).await;
                    }
                }

                ClientMessage::RequestKeyframe { peer_id } => {
                    let room_id = joined_room.clone().unwrap_or_else(|| "default".to_string());
                    let transmits = {
                        let mut mgr = manager.lock().await;
                        mgr.request_keyframe(&room_id, &peer_id)
                    };
                    for t in transmits {
                        let _ = udp_socket.send_to(&t.contents, t.destination).await;
                    }
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
