//! 内置局域网密文中继服务器（Host 模式）
//!
//! 与 `server/index.js` + `server/relay.js` 协议 100% 兼容：
//! - HTTP：`GET /`、`GET /health`、`GET /actions`
//! - WebSocket：`GET /ws`（文本帧 `join`/`relay` + 二进制加密附件分块广播与 `0x02` 私聊定向转发）
//! - 局域网发现：自动通过 Bonjour / mDNS 广播 `_agentws._tcp.local.`，停止或退出时发送下线通告
//! - 隐私保证：纯内存转发密文，不解密、不记录、不落盘；停止服务即清空全部房间状态

use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::State;
use tokio::io::{split, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::{interval, timeout};
use uuid::Uuid;

const PORT_MIN: u16 = 10686;
const PORT_MAX: u16 = 10700;
const SERVICE_TYPE: &str = "_agentws._tcp.local.";
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_ACTIONS_JSON: &str = include_str!("../../server/actions.json");

const MAX_HTTP_HEAD: usize = 8 * 1024;
const MAX_PAYLOAD: usize = 256 * 1024;
const MAX_ACTION_LEN: usize = 200;
const RATE_WINDOW: Duration = Duration::from_millis(5000);
const RATE_MAX_TEXT: u32 = 60;
const RATE_MAX_BYTES: usize = 100 * 1024 * 1024;
const SLOW_PEER_BYTES: usize = 64 * 1024 * 1024;
const HARD_QUEUE_BYTES: usize = 72 * 1024 * 1024;
const PING_INTERVAL: Duration = Duration::from_secs(20);
const DIRECT: u8 = 0x02;
const DIRECT_HEAD: usize = 7;

#[derive(Serialize, Deserialize, Clone)]
struct ActionItem {
    prefix: String,
    #[serde(default)]
    suffix: String,
}

#[derive(Deserialize)]
struct ActionsFile {
    #[serde(default)]
    actions: Vec<ActionItem>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub running: bool,
    pub name: String,
    pub port: u16,
    pub local_addr: String,
    pub share_addr: String,
    pub addrs: Vec<String>,
    pub clients: usize,
    pub rooms: usize,
}

impl RelayStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            name: String::new(),
            port: 0,
            local_addr: String::new(),
            share_addr: String::new(),
            addrs: Vec::new(),
            clients: 0,
            rooms: 0,
        }
    }
}

struct RunningRelay {
    name: String,
    port: u16,
    hub: Arc<Hub>,
    accept_task: JoinHandle<()>,
    ping_task: JoinHandle<()>,
    mdns: Option<(ServiceDaemon, String)>,
}

pub struct RelayState {
    inner: Mutex<Option<RunningRelay>>,
    starting: AtomicBool,
}

impl Default for RelayState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            starting: AtomicBool::new(false),
        }
    }
}

struct StartGuard<'a>(&'a AtomicBool);
impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl RelayState {
    pub fn status(&self) -> RelayStatus {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(r) = guard.as_ref() else {
            return RelayStatus::stopped();
        };
        build_status(&r.name, r.port, &r.hub)
    }

    /// 停止内置服务器并发送 mDNS 下线通告（应用退出、更新重启或手动关闭时调用）
    pub fn shutdown(&self) {
        let running = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(r) = running {
            r.accept_task.abort();
            r.ping_task.abort();
            r.hub.shutdown_all();
            if let Some((mdns, fullname)) = r.mdns {
                if let Ok(rx) = mdns.unregister(&fullname) {
                    let _ = rx.recv_timeout(Duration::from_millis(200));
                }
                let _ = mdns.shutdown();
            }
        }
    }
}

fn build_status(name: &str, port: u16, hub: &Hub) -> RelayStatus {
    let local_addr = format!("127.0.0.1:{port}");
    let addrs: Vec<String> = collect_lan_ips()
        .into_iter()
        .map(|ip| format!("{ip}:{port}"))
        .collect();
    let share_addr = addrs.first().cloned().unwrap_or_else(|| local_addr.clone());
    let (clients, rooms) = hub.counts();
    RelayStatus {
        running: true,
        name: name.to_string(),
        port,
        local_addr,
        share_addr,
        addrs,
        clients,
        rooms,
    }
}

#[tauri::command]
pub fn relay_status(state: State<'_, RelayState>) -> RelayStatus {
    state.status()
}

#[tauri::command]
pub async fn relay_stop(state: State<'_, RelayState>) -> Result<RelayStatus, String> {
    let running = state
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(r) = running {
        r.accept_task.abort();
        r.ping_task.abort();
        r.hub.shutdown_all();
        if let Some((mdns, fullname)) = r.mdns {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Ok(rx) = mdns.unregister(&fullname) {
                    let _ = rx.recv_timeout(Duration::from_millis(250));
                }
                let _ = mdns.shutdown();
            })
            .await;
        }
    }
    Ok(RelayStatus::stopped())
}

#[tauri::command]
pub async fn relay_start(
    state: State<'_, RelayState>,
    name: Option<String>,
    port: Option<u16>,
) -> Result<RelayStatus, String> {
    {
        let cur = state.status();
        if cur.running {
            return Ok(cur);
        }
    }
    if state
        .starting
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("正在启动本机服务，请稍候".into());
    }
    let _guard = StartGuard(&state.starting);

    let relay_name = resolve_relay_name(name.as_deref());
    let (listener, bound_port) = bind_relay_listener(port).await?;
    let hub = Arc::new(Hub::new(relay_name.clone()));

    let mdns_name = relay_name.clone();
    let mdns = tauri::async_runtime::spawn_blocking(move || start_mdns(&mdns_name, bound_port))
        .await
        .ok()
        .flatten();

    let hub_accept = hub.clone();
    let accept_task = tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let h = hub_accept.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_conn(stream, h).await;
                    });
                }
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
    });

    let hub_ping = hub.clone();
    let ping_task = tauri::async_runtime::spawn(async move {
        let mut ticker = interval(PING_INTERVAL);
        ticker.tick().await; // 跳过首次立即触发
        loop {
            ticker.tick().await;
            hub_ping.heartbeat();
        }
    });

    let status = build_status(&relay_name, bound_port, &hub);
    let mut slot = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    *slot = Some(RunningRelay {
        name: relay_name,
        port: bound_port,
        hub,
        accept_task,
        ping_task,
        mdns,
    });
    Ok(status)
}

async fn bind_relay_listener(port: Option<u16>) -> Result<(TcpListener, u16), String> {
    if let Some(p) = port {
        if p < 1024 {
            return Err("端口号需大于等于 1024".into());
        }
        let l = TcpListener::bind(("0.0.0.0", p))
            .await
            .map_err(|e| format!("端口 {p} 无法绑定：{e}"))?;
        return Ok((l, p));
    }
    let mut last_err = String::new();
    for p in PORT_MIN..=PORT_MAX {
        match TcpListener::bind(("0.0.0.0", p)).await {
            Ok(l) => return Ok((l, p)),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!(
        "端口 {PORT_MIN}–{PORT_MAX} 均被占用（{last_err}）"
    ))
}

fn resolve_relay_name(custom: Option<&str>) -> String {
    let clean = |s: &str| -> String {
        s.trim()
            .trim_end_matches(".local")
            .chars()
            .filter(|c| !c.is_control())
            .take(32)
            .collect::<String>()
            .trim()
            .to_string()
    };
    if let Some(s) = custom.map(clean).filter(|s| !s.is_empty()) {
        return s;
    }
    if let Some(h) = crate::secret::host_name().map(|h| clean(&h)).filter(|s| !s.is_empty()) {
        return h;
    }
    "Agent".into()
}

/// 枚举本机私有局域网 IPv4，优先返回物理网卡（Wi-Fi / 有线）地址，排后虚拟网桥
fn collect_lan_ips() -> Vec<Ipv4Addr> {
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut scored: Vec<(u8, Ipv4Addr)> = Vec::new();
    for iface in ifaces {
        let IpAddr::V4(ip) = iface.ip() else {
            continue;
        };
        if !ip.is_private() || ip.is_loopback() {
            continue;
        }
        let low = iface.name.to_ascii_lowercase();
        let is_virtual = [
            "docker", "vbox", "vmnet", "veth", "wsl", "utun", "tun", "tap", "bridge", "virbr",
        ]
        .iter()
        .any(|p| low.contains(p));
        let oct = ip.octets();
        let range_rank = if oct[0] == 192 && oct[1] == 168 {
            0
        } else if oct[0] == 10 {
            1
        } else {
            2
        };
        let rank = if is_virtual { 10 + range_rank } else { range_rank };
        scored.push((rank, ip));
    }
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let mut out = Vec::new();
    for (_, ip) in scored {
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

fn start_mdns(name: &str, port: u16) -> Option<(ServiceDaemon, String)> {
    let mdns = ServiceDaemon::new().ok()?;
    let safe_inst: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '.' && *c != '\\')
        .take(24)
        .collect();
    let inst_prefix = if safe_inst.trim().is_empty() {
        "agent"
    } else {
        safe_inst.trim()
    };
    let short_id = &Uuid::new_v4().simple().to_string()[..6];
    let instance = format!("{inst_prefix}-{port}");
    let host_name = format!("agent-{short_id}.local.");
    let ips: Vec<IpAddr> = collect_lan_ips().into_iter().map(IpAddr::V4).collect();
    let props = [("app", "agent-relay"), ("v", "2"), ("name", name)];
    let info = ServiceInfo::new(
        SERVICE_TYPE,
        &instance,
        &host_name,
        &ips[..],
        port,
        &props[..],
    )
    .ok()?
    .enable_addr_auto();
    let fullname = info.get_fullname().to_string();
    mdns.register(info).ok()?;
    Some((mdns, fullname))
}

fn load_default_actions() -> Vec<ActionItem> {
    let Ok(parsed) = serde_json::from_str::<ActionsFile>(DEFAULT_ACTIONS_JSON) else {
        return Vec::new();
    };
    parsed
        .actions
        .into_iter()
        .map(|a| ActionItem {
            prefix: a.prefix.trim().to_string(),
            suffix: a.suffix.trim().to_string(),
        })
        .filter(|a| {
            !a.prefix.is_empty()
                && a.prefix.encode_utf16().count() + a.suffix.encode_utf16().count()
                    <= MAX_ACTION_LEN
        })
        .take(50)
        .collect()
}

/* ================================================================
 *  纯内存房间与连接交换中心（Hub）
 * ================================================================ */

struct ClientEntry {
    id_bytes: [u8; 6],
    id_hex: String,
    room: Option<String>,
    tx: mpsc::UnboundedSender<Arc<[u8]>>,
    queued_bytes: Arc<AtomicUsize>,
    alive: Arc<AtomicBool>,
    reader_task: JoinHandle<()>,
    writer_task: JoinHandle<()>,
}

impl ClientEntry {
    fn try_enqueue(&self, frame: Arc<[u8]>, is_binary: bool) -> bool {
        let cur = self.queued_bytes.load(Ordering::Relaxed);
        if is_binary && cur >= SLOW_PEER_BYTES {
            return false;
        }
        if cur >= HARD_QUEUE_BYTES {
            return false;
        }
        let len = frame.len();
        self.queued_bytes.fetch_add(len, Ordering::Relaxed);
        if self.tx.send(frame).is_err() {
            self.queued_bytes.fetch_sub(len, Ordering::Relaxed);
            return false;
        }
        true
    }
}

struct HubInner {
    clients: HashMap<u64, ClientEntry>,
    rooms: HashMap<String, Vec<u64>>,
}

struct Hub {
    health_body: String,
    actions_body: String,
    welcome_frame: Arc<[u8]>,
    next_id: AtomicU64,
    inner: Mutex<HubInner>,
}

impl Hub {
    fn new(name: String) -> Self {
        let actions = load_default_actions();
        let health_body = json!({
            "ok": true,
            "name": name,
            "app": "agent-relay",
            "version": 2,
            "features": ["media", "direct"],
        })
        .to_string();
        let actions_body = json!({ "actions": actions }).to_string();
        let welcome_json = json!({
            "type": "welcome",
            "name": name,
            "actions": actions,
            "maxActionLength": MAX_ACTION_LEN,
            "features": ["media", "direct"],
            "version": 2,
        })
        .to_string();
        let welcome_frame = encode_ws_frame(0x1, welcome_json.as_bytes());
        Self {
            health_body,
            actions_body,
            welcome_frame,
            next_id: AtomicU64::new(1),
            inner: Mutex::new(HubInner {
                clients: HashMap::new(),
                rooms: HashMap::new(),
            }),
        }
    }

    fn counts(&self) -> (usize, usize) {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        (g.clients.len(), g.rooms.len())
    }

    fn register_ws<S>(self: &Arc<Self>, reader: WsReader<S>, mut writer: WriteHalf<S>)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let conn_num = self.next_id.fetch_add(1, Ordering::Relaxed);
        let uuid = Uuid::new_v4();
        let mut id_bytes = [0u8; 6];
        id_bytes.copy_from_slice(&uuid.as_bytes()[..6]);
        let id_hex = hex_encode(&id_bytes);

        let (tx, mut rx) = mpsc::unbounded_channel::<Arc<[u8]>>();
        let queued_bytes = Arc::new(AtomicUsize::new(self.welcome_frame.len()));
        let alive = Arc::new(AtomicBool::new(true));
        let _ = tx.send(self.welcome_frame.clone());

        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        let q_writer = queued_bytes.clone();
        let hub_writer = self.clone();
        let writer_task = tauri::async_runtime::spawn(async move {
            while let Some(frame) = rx.recv().await {
                let len = frame.len();
                let res = writer.write_all(&frame).await;
                q_writer.fetch_sub(len, Ordering::Relaxed);
                if res.is_err() {
                    break;
                }
            }
            let _ = writer.shutdown().await;
            hub_writer.disconnect(conn_num);
        });

        let tx_ctrl = tx.clone();
        let q_ctrl = queued_bytes.clone();
        let alive_reader = alive.clone();
        let hub_reader = self.clone();
        let reader_task = tauri::async_runtime::spawn(async move {
            run_ws_reader(conn_num, reader, tx_ctrl, q_ctrl, alive_reader, &hub_reader).await;
            hub_reader.disconnect(conn_num);
        });

        g.clients.insert(
            conn_num,
            ClientEntry {
                id_bytes,
                id_hex,
                room: None,
                tx,
                queued_bytes,
                alive,
                reader_task,
                writer_task,
            },
        );
    }

    fn leave_room_locked(inner: &mut HubInner, conn_num: u64) {
        let Some((old_room, peer_id)) = inner
            .clients
            .get_mut(&conn_num)
            .and_then(|c| c.room.take().map(|r| (r, c.id_hex.clone())))
        else {
            return;
        };
        let mut remaining_peers = Vec::new();
        if let Some(list) = inner.rooms.get_mut(&old_room) {
            list.retain(|&id| id != conn_num);
            if list.is_empty() {
                inner.rooms.remove(&old_room);
            } else {
                remaining_peers = list.clone();
            }
        }
        if !remaining_peers.is_empty() {
            let msg = json!({
                "type": "leave",
                "id": peer_id,
                "count": remaining_peers.len(),
            })
            .to_string();
            let frame = encode_ws_frame(0x1, msg.as_bytes());
            for pid in remaining_peers {
                if let Some(p) = inner.clients.get(&pid) {
                    p.try_enqueue(frame.clone(), false);
                }
            }
        }
    }

    fn disconnect(&self, conn_num: u64) {
        let removed = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !g.clients.contains_key(&conn_num) {
                return;
            }
            Self::leave_room_locked(&mut g, conn_num);
            g.clients.remove(&conn_num)
        };
        if let Some(entry) = removed {
            entry.reader_task.abort();
            entry.writer_task.abort();
        }
    }

    fn heartbeat(&self) {
        let ping_frame = encode_ws_frame(0x9, &[]);
        let mut dead = Vec::new();
        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let dead_ids: Vec<u64> = g
                .clients
                .iter()
                .filter_map(|(&id, c)| {
                    if !c.alive.swap(false, Ordering::Relaxed) {
                        Some(id)
                    } else {
                        c.try_enqueue(ping_frame.clone(), false);
                        None
                    }
                })
                .collect();
            for id in dead_ids {
                Self::leave_room_locked(&mut g, id);
                if let Some(c) = g.clients.remove(&id) {
                    dead.push(c);
                }
            }
        }
        for entry in dead {
            entry.reader_task.abort();
            entry.writer_task.abort();
        }
    }

    fn shutdown_all(&self) {
        let entries: Vec<ClientEntry> = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.rooms.clear();
            g.clients.drain().map(|(_, v)| v).collect()
        };
        for entry in entries {
            entry.reader_task.abort();
            entry.writer_task.abort();
        }
    }

    fn on_text(&self, conn_num: u64, raw: &str) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            return;
        };
        let Some(msg_type) = v.get("type").and_then(|t| t.as_str()) else {
            return;
        };

        if msg_type == "join" {
            let Some(room) = v.get("room").and_then(|r| r.as_str()) else {
                return;
            };
            if !is_valid_room(room) {
                return;
            }
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !g.clients.contains_key(&conn_num) {
                return;
            }
            Self::leave_room_locked(&mut g, conn_num);
            let list = g.rooms.entry(room.to_string()).or_default();
            if !list.contains(&conn_num) {
                list.push(conn_num);
            }
            let peers = list.clone();
            let count = peers.len();
            let my_id = g.clients[&conn_num].id_hex.clone();
            g.clients.get_mut(&conn_num).unwrap().room = Some(room.to_string());

            let joined_msg = json!({ "type": "joined", "id": my_id, "count": count }).to_string();
            let join_msg = json!({ "type": "join", "id": my_id, "count": count }).to_string();
            let joined_frame = encode_ws_frame(0x1, joined_msg.as_bytes());
            let join_frame = encode_ws_frame(0x1, join_msg.as_bytes());

            if let Some(me) = g.clients.get(&conn_num) {
                me.try_enqueue(joined_frame, false);
            }
            for pid in peers {
                if pid != conn_num {
                    if let Some(p) = g.clients.get(&pid) {
                        p.try_enqueue(join_frame.clone(), false);
                    }
                }
            }
            return;
        }

        if msg_type == "relay" {
            let Some(data) = v.get("data").and_then(|d| d.as_str()) else {
                return;
            };
            let to = v.get("to").and_then(|t| t.as_str());
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let Some(me) = g.clients.get(&conn_num) else {
                return;
            };
            let Some(room) = me.room.as_ref() else {
                return;
            };
            let Some(peers) = g.rooms.get(room) else {
                return;
            };
            let out_msg = json!({
                "type": "relay",
                "from": me.id_hex,
                "data": data,
            })
            .to_string();
            let frame = encode_ws_frame(0x1, out_msg.as_bytes());

            if let Some(target_hex) = to {
                for &pid in peers {
                    if let Some(p) = g.clients.get(&pid) {
                        if p.id_hex == target_hex {
                            p.try_enqueue(frame.clone(), false);
                        }
                    }
                }
            } else {
                for &pid in peers {
                    if pid != conn_num {
                        if let Some(p) = g.clients.get(&pid) {
                            p.try_enqueue(frame.clone(), false);
                        }
                    }
                }
            }
        }
    }

    fn on_binary(&self, conn_num: u64, raw: &[u8]) {
        if raw.len() > DIRECT_HEAD && raw[0] == DIRECT {
            let mut target = [0u8; 6];
            target.copy_from_slice(&raw[1..DIRECT_HEAD]);
            let frame = encode_ws_frame(0x2, &raw[DIRECT_HEAD..]);
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let Some(room) = g.clients.get(&conn_num).and_then(|c| c.room.as_ref()) else {
                return;
            };
            let Some(peers) = g.rooms.get(room) else {
                return;
            };
            for &pid in peers {
                if pid != conn_num {
                    if let Some(p) = g.clients.get(&pid) {
                        if p.id_bytes == target {
                            p.try_enqueue(frame.clone(), true);
                        }
                    }
                }
            }
            return;
        }

        let frame = encode_ws_frame(0x2, raw);
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(room) = g.clients.get(&conn_num).and_then(|c| c.room.as_ref()) else {
            return;
        };
        let Some(peers) = g.rooms.get(room) else {
            return;
        };
        for &pid in peers {
            if pid != conn_num {
                if let Some(p) = g.clients.get(&pid) {
                    p.try_enqueue(frame.clone(), true);
                }
            }
        }
    }
}

fn is_valid_room(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/* ================================================================
 *  HTTP + RFC 6455 WebSocket 协议处理
 * ================================================================ */

async fn handle_conn(stream: TcpStream, hub: Arc<Hub>) {
    let _ = stream.set_nodelay(true);
    handle_stream(stream, hub).await;
}

async fn handle_stream<S>(stream: S, hub: Arc<Hub>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut rd, mut wr) = split(stream);

    let Ok(Some((head, leftover))) = timeout(Duration::from_secs(5), read_http_head(&mut rd)).await
    else {
        return;
    };

    let head_str = String::from_utf8_lossy(&head);
    let mut lines = head_str.split("\r\n");
    let Some(req_line) = lines.next() else {
        return;
    };
    let mut parts = req_line.split_whitespace();
    let (Some(method), Some(raw_target)) = (parts.next(), parts.next()) else {
        return;
    };
    let path = raw_target.split('?').next().unwrap_or("/");

    let mut is_upgrade = false;
    let mut ws_key: Option<String> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("upgrade")
                && v.to_ascii_lowercase().contains("websocket")
            {
                is_upgrade = true;
            } else if k.trim().eq_ignore_ascii_case("sec-websocket-key") {
                ws_key = Some(v.trim().to_string());
            }
        }
    }

    if method.eq_ignore_ascii_case("OPTIONS") {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nConnection: close\r\n\r\n";
        let _ = wr.write_all(resp.as_bytes()).await;
        return;
    }

    if is_upgrade {
        if path != "/ws" || !method.eq_ignore_ascii_case("GET") {
            let _ = wr
                .write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
                .await;
            return;
        }
        let Some(key) = ws_key.filter(|k| !k.is_empty()) else {
            let _ = wr
                .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
                .await;
            return;
        };
        let accept = ws_accept_key(&key);
        let resp = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        if wr.write_all(resp.as_bytes()).await.is_err() {
            return;
        }
        let reader = WsReader {
            rd,
            buf: leftover,
            pos: 0,
        };
        hub.register_ws(reader, wr);
        return;
    }

    if method.eq_ignore_ascii_case("GET") && (path == "/" || path == "/health") {
        write_json(&mut wr, "200 OK", &hub.health_body).await;
    } else if method.eq_ignore_ascii_case("GET") && path == "/actions" {
        write_json(&mut wr, "200 OK", &hub.actions_body).await;
    } else {
        write_json(&mut wr, "404 Not Found", r#"{"ok":false}"#).await;
    }
}

async fn read_http_head<R: AsyncRead + Unpin>(rd: &mut R) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    while buf.len() < MAX_HTTP_HEAD {
        let n = rd.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let leftover = buf[pos + 4..].to_vec();
            buf.truncate(pos);
            return Some((buf, leftover));
        }
    }
    None
}

async fn write_json<W: AsyncWrite + Unpin>(wr: &mut W, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = wr.write_all(resp.as_bytes()).await;
    let _ = wr.shutdown().await;
}

struct WsReader<S> {
    rd: ReadHalf<S>,
    buf: Vec<u8>,
    pos: usize,
}

impl<S: AsyncRead + Unpin> WsReader<S> {
    async fn read_exact(&mut self, mut out: &mut [u8]) -> Result<(), ()> {
        if self.pos < self.buf.len() {
            let avail = self.buf.len() - self.pos;
            let take = avail.min(out.len());
            out[..take].copy_from_slice(&self.buf[self.pos..self.pos + take]);
            self.pos += take;
            if self.pos >= self.buf.len() {
                self.buf.clear();
                self.pos = 0;
            }
            out = &mut out[take..];
        }
        if !out.is_empty() {
            self.rd.read_exact(out).await.map_err(|_| ())?;
        }
        Ok(())
    }

    async fn next_frame(&mut self) -> Result<(bool, u8, Vec<u8>), ()> {
        let mut hdr = [0u8; 2];
        self.read_exact(&mut hdr).await?;
        let fin = (hdr[0] & 0x80) != 0;
        if (hdr[0] & 0x70) != 0 {
            return Err(());
        }
        let opcode = hdr[0] & 0x0f;
        let masked = (hdr[1] & 0x80) != 0;
        let len7 = (hdr[1] & 0x7f) as usize;

        if (opcode & 0x08) != 0 && (!fin || len7 > 125) {
            return Err(());
        }

        let len = match len7 {
            126 => {
                let mut ext = [0u8; 2];
                self.read_exact(&mut ext).await?;
                u16::from_be_bytes(ext) as usize
            }
            127 => {
                let mut ext = [0u8; 8];
                self.read_exact(&mut ext).await?;
                let v = u64::from_be_bytes(ext);
                if v > MAX_PAYLOAD as u64 {
                    return Err(());
                }
                v as usize
            }
            n => n,
        };

        if len > MAX_PAYLOAD {
            return Err(());
        }

        let mut mask = [0u8; 4];
        if masked {
            self.read_exact(&mut mask).await?;
        }

        let mut payload = vec![0u8; len];
        if len > 0 {
            self.read_exact(&mut payload).await?;
            if masked {
                for (i, b) in payload.iter_mut().enumerate() {
                    *b ^= mask[i & 3];
                }
            }
        }
        Ok((fin, opcode, payload))
    }
}

async fn run_ws_reader<S: AsyncRead + Unpin>(
    conn_num: u64,
    mut reader: WsReader<S>,
    tx_ctrl: mpsc::UnboundedSender<Arc<[u8]>>,
    q_ctrl: Arc<AtomicUsize>,
    alive: Arc<AtomicBool>,
    hub: &Hub,
) {
    let mut frag: Option<(u8, Vec<u8>)> = None;
    let mut rate_start = Instant::now();
    let mut rate_n: u32 = 0;
    let mut rate_bytes: usize = 0;

    let send_ctrl = |frame: Arc<[u8]>| {
        if q_ctrl.load(Ordering::Relaxed) < HARD_QUEUE_BYTES {
            let len = frame.len();
            q_ctrl.fetch_add(len, Ordering::Relaxed);
            if tx_ctrl.send(frame).is_err() {
                q_ctrl.fetch_sub(len, Ordering::Relaxed);
            }
        }
    };

    while let Ok((fin, opcode, payload)) = reader.next_frame().await {
        alive.store(true, Ordering::Relaxed);
        match opcode {
            0x8 => {
                send_ctrl(encode_ws_frame(0x8, &[]));
                break;
            }
            0x9 => {
                send_ctrl(encode_ws_frame(0xA, &payload));
            }
            0xA => {}
            0x1 | 0x2 => {
                if frag.is_some() {
                    break;
                }
                if fin {
                    if !dispatch_msg(
                        conn_num,
                        opcode,
                        &payload,
                        &mut rate_start,
                        &mut rate_n,
                        &mut rate_bytes,
                        hub,
                    ) {
                        break;
                    }
                } else {
                    frag = Some((opcode, payload));
                }
            }
            0x0 => {
                let Some((orig_op, mut acc)) = frag.take() else {
                    break;
                };
                if acc.len() + payload.len() > MAX_PAYLOAD {
                    break;
                }
                acc.extend_from_slice(&payload);
                if fin {
                    if !dispatch_msg(
                        conn_num,
                        orig_op,
                        &acc,
                        &mut rate_start,
                        &mut rate_n,
                        &mut rate_bytes,
                        hub,
                    ) {
                        break;
                    }
                } else {
                    frag = Some((orig_op, acc));
                }
            }
            _ => break,
        }
    }
}

fn dispatch_msg(
    conn_num: u64,
    opcode: u8,
    raw: &[u8],
    rate_start: &mut Instant,
    rate_n: &mut u32,
    rate_bytes: &mut usize,
    hub: &Hub,
) -> bool {
    let now = Instant::now();
    if now.duration_since(*rate_start) > RATE_WINDOW {
        *rate_start = now;
        *rate_n = 0;
        *rate_bytes = 0;
    }
    *rate_bytes = rate_bytes.saturating_add(raw.len());
    if *rate_bytes > RATE_MAX_BYTES {
        return true; // 超过窗口速率时静默丢弃帧，不强制断开，与 Node 版一致
    }

    if opcode == 0x2 {
        hub.on_binary(conn_num, raw);
        return true;
    }

    *rate_n = rate_n.saturating_add(1);
    if *rate_n > RATE_MAX_TEXT {
        return true;
    }
    let Ok(text) = std::str::from_utf8(raw) else {
        return false;
    };
    hub.on_text(conn_num, text);
    true
}

fn encode_ws_frame(opcode: u8, payload: &[u8]) -> Arc<[u8]> {
    let len = payload.len();
    let hdr_len = if len < 126 {
        2
    } else if len <= u16::MAX as usize {
        4
    } else {
        10
    };
    let mut out = Vec::with_capacity(hdr_len + len);
    out.push(0x80 | (opcode & 0x0f));
    if len < 126 {
        out.push(len as u8);
    } else if len <= u16::MAX as usize {
        out.push(126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(payload);
    out.into()
}

/* ---------------- 纯 Rust SHA-1 + Base64（RFC 6455 握手，零额外依赖） ---------------- */

fn ws_accept_key(key: &str) -> String {
    let mut input = Vec::with_capacity(key.len() + WS_GUID.len());
    input.extend_from_slice(key.trim().as_bytes());
    input.extend_from_slice(WS_GUID.as_bytes());
    base64_encode(&sha1(&input))
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xefcdab89;
    let mut h2: u32 = 0x98badcfe;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xc3d2e1f0;

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(((data.len() + 9 + 63) / 64) * 64);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes(word.try_into().unwrap());
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, word) in [h0, h1, h2, h3, h4].into_iter().enumerate() {
        out[i * 4..(i + 1) * 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 0x3f) as usize] as char);
        out.push(T[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ws_accept_rfc6455_vector() {
        assert_eq!(
            ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn test_default_actions_loaded() {
        let actions = load_default_actions();
        assert!(!actions.is_empty());
        assert!(actions.iter().any(|a| a.prefix == "拍了拍"));
    }

    #[test]
    fn test_room_validation_and_frame_encoding() {
        let good = "a".repeat(64);
        assert!(is_valid_room(&good));
        assert!(!is_valid_room("A".repeat(64).as_str()));
        assert!(!is_valid_room("abc"));

        let small = encode_ws_frame(0x1, b"hello");
        assert_eq!(&*small, &[0x81, 5, b'h', b'e', b'l', b'l', b'o']);

        let med_payload = vec![0x42u8; 300];
        let med = encode_ws_frame(0x2, &med_payload);
        assert_eq!(med[0], 0x82);
        assert_eq!(med[1], 126);
        assert_eq!(u16::from_be_bytes([med[2], med[3]]), 300);
        assert_eq!(&med[4..], &med_payload[..]);
    }

    fn make_masked_client_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mask = [0x12, 0x34, 0x56, 0x78];
        let mut out = Vec::new();
        out.push(0x80 | opcode);
        if payload.len() < 126 {
            out.push(0x80 | (payload.len() as u8));
        } else {
            out.push(0x80 | 126);
            out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        out.extend_from_slice(&mask);
        for (i, &b) in payload.iter().enumerate() {
            out.push(b ^ mask[i & 3]);
        }
        out
    }

    #[test]
    fn test_end_to_end_http_and_ws_relay() {
        use tokio::io::{duplex, DuplexStream};

        tauri::async_runtime::block_on(async {
            let hub = Arc::new(Hub::new("test-host".into()));

            let spawn_pipe = |h: Arc<Hub>| -> DuplexStream {
                let (client, server) = duplex(64 * 1024);
                tauri::async_runtime::spawn(async move {
                    handle_stream(server, h).await;
                });
                client
            };

            // 1. 验证 /health
            let mut http_conn = spawn_pipe(hub.clone());
            http_conn
                .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .await
                .unwrap();
            let mut resp = Vec::new();
            http_conn.read_to_end(&mut resp).await.unwrap();
            let resp_str = String::from_utf8_lossy(&resp);
            assert!(resp_str.contains("200 OK"));
            assert!(resp_str.contains("\"app\":\"agent-relay\""));
            assert!(resp_str.contains("\"test-host\""));

            // 2. 建立两个 WebSocket 客户端连接
            async fn ws_connect(
                s: DuplexStream,
            ) -> (WsReader<DuplexStream>, WriteHalf<DuplexStream>, serde_json::Value) {
                let (mut rd, mut wr) = split(s);
                let req = "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
                wr.write_all(req.as_bytes()).await.unwrap();
                let (head, leftover) = read_http_head(&mut rd).await.unwrap();
                assert!(String::from_utf8_lossy(&head).contains("101 Switching Protocols"));
                let mut wsr = WsReader { rd, buf: leftover, pos: 0 };
                let (_, op, welcome_bytes) = wsr.next_frame().await.unwrap();
                assert_eq!(op, 0x1);
                let welcome: serde_json::Value = serde_json::from_slice(&welcome_bytes).unwrap();
                assert_eq!(welcome["type"], "welcome");
                (wsr, wr, welcome)
            }

            let (mut r1, mut w1, _) = ws_connect(spawn_pipe(hub.clone())).await;
            let (mut r2, mut w2, _) = ws_connect(spawn_pipe(hub.clone())).await;
            let room = "f".repeat(64);

            // 客户端 1 加入房间
            let j1 = json!({ "type": "join", "room": room }).to_string();
            w1.write_all(&make_masked_client_frame(0x1, j1.as_bytes())).await.unwrap();
            let (_, _, b) = r1.next_frame().await.unwrap();
            let m1: serde_json::Value = serde_json::from_slice(&b).unwrap();
            assert_eq!(m1["type"], "joined");
            assert_eq!(m1["count"], 1);
            let id1 = m1["id"].as_str().unwrap().to_string();

            // 客户端 2 加入同房间
            w2.write_all(&make_masked_client_frame(0x1, j1.as_bytes())).await.unwrap();
            let (_, _, b2) = r2.next_frame().await.unwrap();
            let m2: serde_json::Value = serde_json::from_slice(&b2).unwrap();
            assert_eq!(m2["type"], "joined");
            assert_eq!(m2["count"], 2);
            let id2 = m2["id"].as_str().unwrap().to_string();

            // 客户端 1 收到 join 广播
            let (_, _, bj) = r1.next_frame().await.unwrap();
            let mj: serde_json::Value = serde_json::from_slice(&bj).unwrap();
            assert_eq!(mj["type"], "join");
            assert_eq!(mj["id"], id2);

            // 文本密文转发（定向 to）
            let rel = json!({ "type": "relay", "data": "cipher123", "to": id2 }).to_string();
            w1.write_all(&make_masked_client_frame(0x1, rel.as_bytes())).await.unwrap();
            let (_, _, br) = r2.next_frame().await.unwrap();
            let mr: serde_json::Value = serde_json::from_slice(&br).unwrap();
            assert_eq!(mr["type"], "relay");
            assert_eq!(mr["from"], id1);
            assert_eq!(mr["data"], "cipher123");

            // 二进制定向帧（0x02 + 6B target conn id + payload）剥头转发验证
            let mut bin_pkt = vec![DIRECT];
            for i in 0..6 {
                bin_pkt.push(u8::from_str_radix(&id1[i * 2..i * 2 + 2], 16).unwrap());
            }
            bin_pkt.extend_from_slice(b"encrypted-chunk-payload");
            w2.write_all(&make_masked_client_frame(0x2, &bin_pkt)).await.unwrap();
            let (_, op_bin, bin_recv) = r1.next_frame().await.unwrap();
            assert_eq!(op_bin, 0x2);
            assert_eq!(&bin_recv[..], b"encrypted-chunk-payload");

            // 客户端 2 断开，客户端 1 收到 leave
            drop(w2);
            drop(r2);
            let (_, _, bl) = r1.next_frame().await.unwrap();
            let ml: serde_json::Value = serde_json::from_slice(&bl).unwrap();
            assert_eq!(ml["type"], "leave");
            assert_eq!(ml["id"], id2);
            assert_eq!(ml["count"], 1);

            hub.shutdown_all();
        });
    }
}
