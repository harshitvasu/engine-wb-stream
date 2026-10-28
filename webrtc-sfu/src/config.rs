use std::net::{IpAddr, Ipv4Addr, SocketAddr};

#[derive(Debug, Clone)]
pub struct Config {
    pub signaling_host: IpAddr,
    pub signaling_port: u16,
    pub udp_bind_host: IpAddr,
    pub udp_port: u16,
    pub public_ip: IpAddr,
    pub lan_ip: Option<IpAddr>,
}

impl Config {
    fn load_env_file() {
        for path in &[".env", "../.env"] {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    if let Some((k, v)) = trimmed.split_once('=') {
                        let key = k.trim();
                        let val = v.trim().trim_matches('"').trim_matches('\'');
                        if std::env::var(key).is_err() {
                            std::env::set_var(key, val);
                        }
                    }
                }
                break;
            }
        }
    }

    pub fn from_env() -> Self {
        Self::load_env_file();
        let signaling_host: IpAddr = std::env::var("SFU_SIGNALING_HOST")
            .unwrap_or_else(|_| "0.0.0.0".to_string())
            .parse()
            .unwrap_or(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0)));

        let signaling_port: u16 = std::env::var("SFU_SIGNALING_PORT")
            .unwrap_or_else(|_| "3088".to_string())
            .parse()
            .unwrap_or(3088);

        let udp_bind_host: IpAddr = std::env::var("SFU_UDP_BIND_HOST")
            .unwrap_or_else(|_| "0.0.0.0".to_string())
            .parse()
            .unwrap_or(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0)));

        let udp_port: u16 = std::env::var("SFU_UDP_PORT")
            .unwrap_or_else(|_| "40000".to_string())
            .parse()
            .unwrap_or(40000);

        let detected_lan = Self::detect_lan_ip();
        let env_public: Option<IpAddr> = std::env::var("SFU_PUBLIC_IP").ok().and_then(|s| s.parse().ok());
        let detected_public = env_public.or_else(Self::detect_public_ip);

        let public_ip = match detected_public {
            Some(ip) if !ip.is_loopback() => ip,
            _ => detected_lan.unwrap_or(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
        };

        // If lan_ip detection yielded None but public_ip is a non-loopback address (e.g. 192.168.1.6),
        // use it as lan_ip so Wi-Fi candidates and UDP packet routing match
        let lan_ip = detected_lan.or_else(|| {
            if !public_ip.is_loopback() {
                Some(public_ip)
            } else {
                None
            }
        });

        Self {
            signaling_host,
            signaling_port,
            udp_bind_host,
            udp_port,
            public_ip,
            lan_ip,
        }
    }

    /// Checks if an IP is in a private RFC 1918, loopback, or link-local range
    pub fn is_private_ip(ip: &IpAddr) -> bool {
        match ip {
            IpAddr::V4(ipv4) => {
                let o = ipv4.octets();
                ipv4.is_loopback()
                    || o[0] == 10
                    || (o[0] == 172 && (16..=31).contains(&o[1]))
                    || (o[0] == 192 && o[1] == 168)
                    || (o[0] == 169 && o[1] == 254)
            }
            IpAddr::V6(ipv6) => ipv6.is_loopback(),
        }
    }

    /// Automatically detects public IP address via AWS EC2 Instance Metadata (IMDS) or external echo
    pub fn detect_public_ip() -> Option<IpAddr> {
        // 1. AWS EC2 Instance Metadata Service (IMDS) - sub-millisecond latency on EC2
        #[cfg(unix)]
        {
            if let Ok(output) = std::process::Command::new("sh")
                .arg("-c")
                .arg("curl -s --connect-timeout 1 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null")
                .output()
            {
                if output.status.success() {
                    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if let Ok(ip) = text.parse::<IpAddr>() {
                        if !Self::is_private_ip(&ip) {
                            return Some(ip);
                        }
                    }
                }
            }

            // 2. AWS checkip fallback
            if let Ok(output) = std::process::Command::new("sh")
                .arg("-c")
                .arg("curl -s --connect-timeout 2 http://checkip.amazonaws.com 2>/dev/null")
                .output()
            {
                if output.status.success() {
                    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if let Ok(ip) = text.parse::<IpAddr>() {
                        if !Self::is_private_ip(&ip) {
                            return Some(ip);
                        }
                    }
                }
            }
        }

        None
    }

    /// Automatically detects the active local network (LAN) IP via OS routing table or ifconfig
    pub fn detect_lan_ip() -> Option<IpAddr> {
        // Strategy 1: UDP routing probe (fastest, works on most networks)
        if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if socket.connect("8.8.8.8:80").is_ok() {
                if let Ok(local_addr) = socket.local_addr() {
                    let ip = local_addr.ip();
                    if !ip.is_unspecified() && !ip.is_loopback() {
                        return Some(ip);
                    }
                }
            }
        }

        // Strategy 2: Query system command (macOS / Linux fallback when offline or in sandbox)
        #[cfg(unix)]
        {
            if let Ok(output) = std::process::Command::new("sh")
                .arg("-c")
                .arg("ifconfig | awk '/inet / && $2 != \"127.0.0.1\" && $2 !~ /^169\\.254/ {print $2; exit}'")
                .output()
            {
                if output.status.success() {
                    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if let Ok(ip) = text.parse::<IpAddr>() {
                        if !ip.is_unspecified() && !ip.is_loopback() {
                            return Some(ip);
                        }
                    }
                }
            }
        }

        None
    }

    pub fn signaling_addr(&self) -> SocketAddr {
        SocketAddr::new(self.signaling_host, self.signaling_port)
    }

    pub fn udp_bind_addr(&self) -> SocketAddr {
        SocketAddr::new(self.udp_bind_host, self.udp_port)
    }

    pub fn public_media_addr(&self) -> SocketAddr {
        SocketAddr::new(self.public_ip, self.udp_port)
    }

    pub fn lan_media_addr(&self) -> Option<SocketAddr> {
        self.lan_ip.map(|ip| SocketAddr::new(ip, self.udp_port))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_lan_ip() {
        let ip = Config::detect_lan_ip();
        println!("Detected LAN IP: {:?}", ip);
        let cfg = Config::from_env();
        println!("Config public_ip: {:?}", cfg.public_ip);
        println!("Config lan_ip: {:?}", cfg.lan_ip);
    }
}
