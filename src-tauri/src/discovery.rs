//! 局域网自动发现服务器
//!
//! 1. `discover_servers`：浏览 Bonjour（mDNS）服务 `_agentws._tcp`，只是监听广播，不扫描任何主机。
//! 2. `scan_subnet`：兜底方案，只在用户点击「Scan」时调用。
//!    只探测本机所在私有网段（/24）里的一个固定端口，限制并发，避免产生大量连接。
//!    端口通了以后再请求 `/health`，确认对方确实是我们的服务器。

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::timeout;

const SERVICE_TYPE: &str = "_agentws._tcp.local.";
const SCAN_CONCURRENCY: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(350);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(1200);
const MAX_SUBNETS: usize = 2;

#[derive(Serialize, Clone, PartialEq, Eq, Hash)]
pub struct Found {
    name: String,
    host: String,
    port: u16,
}

/// 只接受私有网段地址（10/8、172.16/12、192.168/16），排除 Tailscale 等 VPN 的 100.x 地址
fn is_lan(ip: &Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_loopback()
}

fn clean_name(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(40).collect()
}

/// 在原生层探测服务器 `/health`（强制 HTTP/1.1，避免 macOS WebKit 缓存 HTTP/2 ALPN 后导致同源 wss:// Upgrade 被 Nginx 400 拒绝）
#[tauri::command]
pub async fn health_check(url: String, timeout_ms: Option<u64>) -> Result<String, String> {
    let u = url.trim().to_string();
    if !u.starts_with("http://") && !u.starts_with("https://") {
        return Err("invalid url".into());
    }
    if u.len() > 512 || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("invalid url".into());
    }
    let secs = ((timeout_ms.unwrap_or(3000).clamp(1000, 10000) + 999) / 1000).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        #[allow(unused_mut)]
        let mut cmd = std::process::Command::new("curl");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd
            .args(["-fsSL", "--http1.1", "--max-time", &secs, "-H", "Cache-Control: no-store", "--", &u])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err("unreachable".into());
        }
        String::from_utf8(out.stdout).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn discover_servers(timeout_ms: Option<u64>) -> Result<Vec<Found>, String> {
    let wait = Duration::from_millis(timeout_ms.unwrap_or(1500).clamp(300, 5000));
    tauri::async_runtime::spawn_blocking(move || browse(wait))
        .await
        .map_err(|e| e.to_string())?
}

fn browse(wait: Duration) -> Result<Vec<Found>, String> {
    let mdns = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let rx = mdns.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;
    let mut deadline = Instant::now() + wait;
    let mut out: Vec<Found> = Vec::new();
    let mut seen = HashSet::new();

    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                if info.get_property_val_str("app") != Some("agent-relay") {
                    continue;
                }
                let name = clean_name(info.get_property_val_str("name").unwrap_or("relay"));
                let mut addrs: Vec<Ipv4Addr> = info.get_addresses_v4().into_iter().filter(is_lan).collect();
                addrs.sort();
                // 同一台服务器可能有多个地址（有线 + Wi-Fi），每个都列出来，由前端探测哪个能连
                for ip in addrs {
                    let f = Found { name: name.clone(), host: ip.to_string(), port: info.port };
                    if seen.insert(f.clone()) {
                        out.push(f);
                    }
                }
                // 找到第一个后再多等一小会儿收集其他服务器，不必等满整个窗口
                if !out.is_empty() {
                    deadline = deadline.min(Instant::now() + Duration::from_millis(400));
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = mdns.stop_browse(SERVICE_TYPE);
    let _ = mdns.shutdown();
    Ok(out)
}

#[tauri::command]
pub async fn scan_subnet(port: u16) -> Result<Vec<Found>, String> {
    if port < 1024 {
        return Err("invalid port".into());
    }
    let mut prefixes: Vec<[u8; 3]> = Vec::new();
    for iface in if_addrs::get_if_addrs().map_err(|e| e.to_string())? {
        if let IpAddr::V4(ip) = iface.ip() {
            let o = ip.octets();
            let p = [o[0], o[1], o[2]];
            if is_lan(&ip) && !prefixes.contains(&p) {
                prefixes.push(p);
            }
        }
    }
    prefixes.truncate(MAX_SUBNETS);

    let sem = Arc::new(Semaphore::new(SCAN_CONCURRENCY));
    let mut tasks = tokio::task::JoinSet::new();
    for p in prefixes {
        for host in 1..=254u8 {
            let ip = Ipv4Addr::new(p[0], p[1], p[2], host);
            let sem = sem.clone();
            tasks.spawn(async move {
                let _permit = sem.acquire_owned().await.ok()?;
                probe(ip, port).await
            });
        }
    }
    let mut out = Vec::new();
    while let Some(res) = tasks.join_next().await {
        if let Ok(Some(f)) = res {
            out.push(f);
        }
    }
    out.sort_by(|a, b| a.host.cmp(&b.host));
    Ok(out)
}

/// 端口通了以后请求 /health，确认是 agent-relay
async fn probe(ip: Ipv4Addr, port: u16) -> Option<Found> {
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    let mut stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await.ok()?.ok()?;
    let req = format!("GET /health HTTP/1.0\r\nHost: {ip}:{port}\r\nConnection: close\r\n\r\n");
    let body = timeout(HEALTH_TIMEOUT, async {
        stream.write_all(req.as_bytes()).await.ok()?;
        let mut buf = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        while buf.len() < 8192 {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Some(buf)
    })
    .await
    .ok()??;
    let text = String::from_utf8_lossy(&body);
    let json = text.split_once("\r\n\r\n")?.1;
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    if v.get("app")?.as_str()? != "agent-relay" {
        return None;
    }
    let name = clean_name(v.get("name").and_then(|n| n.as_str()).unwrap_or("relay"));
    Some(Found { name, host: ip.to_string(), port })
}

