// 预留：从固定地址拉取服务器列表。留空则不拉取。
// 返回格式：{ "servers": [ { "name": "办公室", "url": "192.168.1.5:10686" } ] }
// 该地址需要返回 CORS 头 Access-Control-Allow-Origin: *
export const SERVER_LIST_URL = '';

export const DEFAULT_PORT = 10686; // 约定端口：服务器默认 10686，被占用时递增到 10700
export const DISCOVERY_PORT = 10686; // 「Scan」兜底扫描只探测这一个端口
export const MAX_ACTION_LEN = 200;
