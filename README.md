# private-chat (ChatBuddy)

局域网阅后即焚聊天：macOS / Windows 原生客户端（Tauri）+ Android 客户端（Flutter），应用名为 **ChatBuddy**，界面伪装成多模型 AI 对话工作台（默认中文，支持中英切换），消息端到端加密。服务器只转发密文，不存储任何内容。

```
private-chat/
├── server/        密文中继服务器（独立目录，可以单独拷到任何机器上运行，也有 Docker 镜像）
├── src/           客户端前端
├── src-tauri/     原生外壳（菜单栏 / 托盘、Dock 角标、通知）
├── mobile/        Android 客户端（Flutter），只连接已有服务器，见 mobile/README.md
└── .github/       打包流水线（Docker + macOS + Windows → GitHub Release）
```

不想自己编译的话，直接到 [Releases](https://github.com/mrxf/channel-chat/releases) 下载安装包。

## 1. 启动服务器

### 方式一：任意客户端一键开启（推荐 · 局域网零依赖）

局域网内不需要安装 Node.js 或 Docker，**任意一台桌面客户端都可以直接充当服务器**：

1. 打开 `ChatBuddy` 客户端，在登录页连接向导中点击 **开启本机房间**（用我的电脑建房间），客户端会在本机 Rust 层直接启动密文中继（默认端口 `10686`，占用则自动递增到 `10700`）并通过 Bonjour / mDNS 在局域网广播。
2. 房主本机自动使用回环地址连接，向导卡片和顶栏 **分享地址**（或输入 `/host`）都会直接展示并支持一键复制本机真实的局域网 IP（如 `192.168.1.23:10686`）。
3. 同一局域网里的其他人打开客户端，登录页会自动发现并填入该地址（或点 **扫描查找** 扫描同一 Wi-Fi 内的房间）。
4. 进入会话后，可随时在设置里的 **本机充当服务器（建房间）** 查看连接数、复制地址或开关服务；点窗口关闭按钮隐藏到托盘时服务继续运行，退出应用或关闭开关时自动发送下线通告并清空全部内存。

### 方式二：独立 Node.js / Docker 服务器（适合公网云服务器或常驻部署）

```bash
npm run server                       # 默认端口 10686，被占用时依次尝试到 10700
node server/index.js --port 10690    # 指定端口
node server/index.js --no-discovery  # 不在局域网广播（只能手动填地址）
```

只需要 Node 18 以上。私聊发图片 / 视频需要 1.1.4 以后的服务器（文字私聊不受影响），更新 server 目录后重启即可。拷到别的机器单独运行：`cd server && npm i && npm start`。

**Docker**（镜像由流水线发布到 GitHub Container Registry，支持 amd64 / arm64）：

```bash
# Linux 服务器：用主机网络，局域网自动发现可用
docker run -d --name channel-chat --restart unless-stopped --network host ghcr.io/mrxf/channel-chat-server:latest

# Docker Desktop（macOS / Windows）：主机网络不可用，映射端口并关闭自动发现，客户端手动填地址
docker run -d --name channel-chat --restart unless-stopped -p 10686:10686 -e NO_DISCOVERY=1 ghcr.io/mrxf/channel-chat-server:latest
```

可用的环境变量：`PORT`（默认 10686）、`RELAY_NAME`（广播的名称，默认主机名）、`NO_DISCOVERY=1`。要自定义预制动作，把自己的文件挂进去：`-v $PWD/actions.json:/app/actions.json:ro`。

启动后终端会打印可以填写的地址，比如 `192.168.1.5:10686`。服务器日志只记录连接数和房间数，不记录任何内容。

**局域网自动发现**：服务器启动后会通过 Bonjour（mDNS，和 AirDrop、打印机发现是同一套机制）在局域网里广播自己的名称和端口。客户端打开登录页时会监听 1～2 秒：

- 只找到一个服务器，并且当前没有填写可用的地址：自动填上。
- 找到多个：自动填第一个，其他的在输入框的下拉列表里。
- 一个都没找到：可以点 Server 输入框右边的 **Scan**。它会先再听一次广播，还是没有的话，在本机所在的 /24 网段里探测约定端口 10686（约 254 个连接，限速进行，大约 5 秒）。只有点击时才会扫描。
- 公司网络屏蔽了组播、服务器换了端口，或者不在同一网段时，手动输入地址即可。

广播内容只有服务器名称和端口，不含任何会话信息。如果不想被局域网里的其他人看到，用 `--no-discovery` 启动。

## 2. 客户端

```bash
npm install
npm run app          # 开发模式运行
npm run app:build    # 版本号 +1（1.1.0 → 1.1.1）后打包成 .app 和 .dmg
```

版本号只在 `package.json` 里维护，打包时会自动同步到应用和 `Cargo.toml`：

| 命令 | 作用 |
|---|---|
| `npm run app:build` | 补丁号 +1 后打包（日常用这个） |
| `npm run app:build:minor` | 次版本号 +1 后打包（1.1.3 → 1.2.0），适合加了新功能时 |
| `npm run app:build:same` | 不改版本号，重新打包 |
| `npm run version:bump 2.0.0` | 只改版本号，不打包 |

当前版本可以在三个地方看到：登录页右下角、设置里的 Version（含打包时间）、Finder 里的「显示简介」。客户端启动后会自动静默检查 GitHub Releases 是否有新版本（也可在设置 Version 行点 **Check** 或输入 `/update` 手动检查）；发现新版本时，点 **更新并重启** 即可自动下载安装包、校验 `SHA256SUMS.txt`、替换应用（macOS 自动清除隔离属性免拦截；Windows 支持安装版静默升级与免安装版原地替换）并自动重启生效。双方版本不一致时，对话里也会提示并自动触发检查。

打包产物在 `src-tauri/target/release/bundle/` 下：

- `macos/ChatBuddy.app`
- `dmg/ChatBuddy_<版本号>_aarch64.dmg`

在 Windows 上执行同样的命令，产物是 `bundle/nsis/ChatBuddy_<版本号>_x64-setup.exe`（需要 Rust 和 Node，打包工具会自动下载 NSIS）。

应用没有签名：

- macOS：第一次打开如果提示无法验证开发者，到「系统设置 → 隐私与安全性」点「仍要打开」，或者执行 `xattr -cr /Applications/ChatBuddy.app`。
- Windows：SmartScreen 拦截时点「更多信息 → 仍要运行」。

Windows 版和 macOS 版功能一致，有几处系统差异：未读数显示在托盘图标的悬停提示里（Windows 没有 Dock 角标和菜单栏数字），关闭窗口后程序留在右下角托盘里。

### 发布新版本

```bash
npm run release            # 补丁号 +1 → 提交 → 打 tag → 推送
npm run release minor      # 次版本号 +1
npm run release current    # 不改版本号，直接给当前版本打 tag
```

推送 `v*` tag 后，GitHub Actions 会并行完成：

| 任务 | 产物 |
|---|---|
| macOS | `ChatBuddy_<版本>_macOS_universal.dmg`（Apple 芯片和 Intel 通用） |
| Windows | `ChatBuddy_<版本>_Windows_x64-setup.exe` 安装版、`ChatBuddy_<版本>_Windows_x64_portable.exe` 免安装版 |
| Android | `ChatBuddy_<版本>_Android_arm64.apk`（主流手机）、`ChatBuddy_<版本>_Android_armv7.apk`（旧款 32 位手机） |
| Docker | `ghcr.io/mrxf/channel-chat-server:<版本>` 和 `:latest`（amd64 + arm64） |
| 服务端压缩包 | `channel-chat-server_<版本>.tar.gz`，给不用 Docker 的机器 |

全部成功后自动创建 Release，附带下载说明和 `SHA256SUMS.txt`，大约 15 分钟。只想试试能不能打包、不发布：推送到任意 `ci/` 开头的分支（比如 `git push origin HEAD:ci/test`），或者在 Actions 页面点 **Run workflow**，安装包在那次运行的 Artifacts 里。

登录页三项：

- **Server**：服务器地址，输入时会实时检测是否在线。
- **Display name**：显示名称。
- **Session key**：会话口令。点 **Generate** 会生成一个随机口令并复制，发给对方即可。勾选 **Remember on this Mac**（Windows 上是 Remember on this PC）后会加密保存在本机，下次不用再输。

## 功能

| 功能 | 说明 |
|---|---|
| 群聊 + 私聊 | 输入同一个口令的人都在一个会话里。侧栏第一条是群聊，下面每个在线的人各有一条私聊（右侧小字是对方的名字和颜色点），点哪条就和谁聊，每条各有未读数。顶部标题旁显示当前在和谁聊。私聊消息、图片、视频只发给对方，其他人收不到 |
| 阅后即焚 | 每个会话只保留最近 N **轮**对话（默认 1）。同一个人连续发的消息算一轮，换人说话才算新的一轮：N = 1 时对方连发 5 条会全部留着，等有人回复后，上一轮里已读的消息才焚毁。未读消息不会被焚毁；每条消息下方可单独清除，右上角 **Clear**（或输入 `/cls`）可一键清屏（仅清空自己屏幕） |
| 已读判定 | 收到的消息：正在看这个会话、窗口在前台，并且停留够阅读时长才算已读。自己发的消息：气泡右下角以小图标展示状态（单勾 `✓` 已发送，对方读完变为绿色双勾 `✓✓`）；群聊多人接收时同步显示已读人数（如 `1/2`），悬停可查看详情；发送时在线的人**全部**发回已读回执才算已读，有人中途离开就不再等他 |
| 倒计时焚毁 | 已读后 10s / 30s / 1min / 5min 焚毁 |
| 菜单栏 / Dock 数字 | 未读数同时显示在菜单栏图标旁和 Dock 角标上 |
| 系统通知 | 只提示「任务有新的进展」，不含内容和发送者，可在设置里关闭 |
| 图片 / 视频 | 点输入框的📎、直接粘贴截图，或者把文件拖进窗口都可以发送。收到时是模糊的，点「View」才解密显示。图片看 N 秒后焚毁，视频播完 N 秒后焚毁（N 默认 10 秒，全房间同步）。视频上限 50MB |
| 动作（拍一拍） | 输入框左侧的 ＋：服务器预制的动作，或自定义「___ 对方的 ___」（合计不超过 200 字）。私聊里对方会看到「小王拍了拍你的电脑」，群聊里大家看到「小王拍了拍大家的电脑」，窗口会抖一下，Dock 图标跳一下 |
| 伪装 | 对方的消息显示成 AI 回复，自己的消息显示成提问。顶部有一个假装正在运行的后台任务，日志会滚动、进度会推进 |
| 伪装场景 | 设置里的 **Workspace profile**，按工种切换侧栏历史记录、顶部后台任务、对方消息的工具行和老板键伪装页：研发、文字创作、通用 · 办公、通用 · 调研分析。只影响自己的界面，双方可以选不同的 |
| 成员显示 | 设置里的 **Member labels**：Name 显示真名，Alias 给每人一个固定的子 Agent 代号（Explore agent、Review agent…），旁边的人看着像好几个 Agent 在干活。只影响自己的界面。两个人同名时自动加后缀区分（小李·4e4） |
| 侧栏重命名 | 双击侧栏 Recents 里的任务名（包括私聊条目，或悬停后点 ✎）即可改名，回车保存，`Esc` 取消，清空恢复默认。名称按伪装场景分别记住，下次打开不变；设置里的 **Sidebar names → Reset** 一键恢复 |
| 老板键 | `Esc` 切换到一段假的编码对话，可以开启「失焦自动伪装」 |
| 禁止截图 | 设置里打开后，系统截图、录屏、共享屏幕时窗口都是空白的 |
| 关闭窗口 | 只是隐藏，连接保持（开启了 **Local relay** 时本机中继服务也继续运行）。点 Dock 或菜单栏图标恢复，在菜单栏里选 Quit 退出 |
| 本机开服 | 登录页点 **Host** 或设置里开启 **Local relay**（也可输入 `/host`），客户端内置 Rust 中继直接充当局域网服务器，无需安装 Node.js |
| 命令 | `/cls` 清屏（仅自己），`/host` 开启/复制本机服务地址，`/clear` 清空当前会话（参与者一起清空），`/update` 检查更新，`/keep 3`，`/ttl 30`，`/hide`，`/leave` |

## 移动端

`mobile/` 是 Flutter 写的 Android 客户端，和桌面端在同一个房间里互通（同一服务器 + 同一口令）：群聊、私聊、已读回执、阅后即焚、图片 / 视频、拍一拍、房间设置同步都支持。界面是普通的对话界面，没有桌面端的伪装；不能自己开服务器。开发和打包见 [mobile/README.md](mobile/README.md)。在 Actions 页面手动运行 **Android** 工作流即可打包，手机打开 [Android 测试版](https://github.com/mrxf/channel-chat/releases/tag/android-nightly) 直接下载；正式发版时 APK 会一起出现在 Release 里。

## 服务器配置

**预制动作**：编辑 `server/actions.json`，保存后新连接立即生效，不用重启。

```json
{ "actions": [ { "prefix": "拍了拍", "suffix": "肩膀" }, { "prefix": "抱了抱", "suffix": "" } ] }
```

显示规则：对方看到的是「{你}{prefix}你的{suffix}」，suffix 为空时是「{你}{prefix}你」。

**服务器列表（预留）**：在 `src/config.js` 里填写 `SERVER_LIST_URL`，客户端启动时会去拉取，结果出现在 Server 输入框的下拉提示里。格式如下：

```json
{ "servers": [ { "name": "办公室", "url": "192.168.1.5:10686" } ] }
```

这个地址需要返回 `Access-Control-Allow-Origin: *`。

**HTTP 接口**：

- `GET /health`：在线检测
- `GET /actions`：返回动作列表

## 安全模型

- 口令在本地用 scrypt（N=2^15）拉伸，再用 HKDF 派生出加密密钥、房间 ID 和指纹。口令不会离开本机。
- 消息用 XChaCha20-Poly1305 加密，明文按 256 字节补齐，隐藏消息长度。
- 服务器只能看到房间 ID（哈希值）、密文和连接数。拍一拍、已读回执、设置同步也全部是加密的。
- 私聊和群聊用同一个房间口令加密，持有口令就能解开（方便审核）。私聊的隔离靠服务器定向转发：私聊消息和附件分块只发给对方的连接，其他成员收不到密文。服务器能看到「某个连接给另一个连接发了多少字节」，看不到内容。
- 每个成员进入会话时随机生成一个只在内存里的 ID，并和服务器分配的连接绑定，其他客户端无法冒用你的身份发消息。持有口令的人之间是互相信任的。
- 本地只保存名称、服务器地址、主题、自定义动作和侧栏任务名，不保存任何消息。私聊条目的自定义名称以「口令指纹 + 对方名字」的哈希为键保存，不知道口令的人看不出是和谁的私聊。偏好存在 `~/Library/Application Support/com.agentworkspace.desktop/prefs.json`（Windows：`%APPDATA%\com.agentworkspace.desktop\prefs.json`；开发版用 `prefs.dev.json`，互不覆盖）。
- 口令：登录页勾选「Remember on this Mac」（默认勾选）时，口令用本机硬件 ID（macOS 是硬件 UUID，Windows 是 MachineGuid）派生的密钥加密（XChaCha20-Poly1305），保存在配置目录的 `session.dat`（开发版 `session.dev.dat`，权限 600），下次打开自动填好，直接回车即可进入。取消勾选会立即删除。不使用系统钥匙串，不会弹授权窗口。文件拷到别的电脑上解不开，但能登录这台 Mac 账户的人可以解开，所以电脑本身请设好登录密码（最好开启 FileVault / BitLocker）。
- 附件处理：
  - 发送前，图片在本地重新编码（最长边 2048px），去掉 EXIF、GPS 等元数据。
  - 内容按 64KB 分块，每块单独加密（块序号也纳入加密校验）。
  - 接收方收到后，分块一直保持加密状态放在内存里，点查看才解密。
  - 图片直接画在 canvas 上，没有任何可以被缓存或另存的地址。
  - 视频和 GIF 交给 Rust 端，只放在内存里，通过 `vault://` 协议播放。焚毁时缓冲区全部清零。
- WebView 运行在无痕模式下，不写任何磁盘缓存。实测收发图片和视频的全过程，磁盘上搜不到任何内容残留。
- 发送方不保留文件副本，只保留模糊缩略图，用来显示「已送达」「对方已查看」等状态。
- 双方核对设置里的 Fingerprint，可以确认两边口令一致。
- 局限：
  - 挡不住用手机拍屏幕。
  - 内存紧张时，内存内容可能被系统换到交换区，不过 macOS 的交换区是加密的。
  - 附件要求对方在线，服务器不会暂存。
  - 口令越长越安全。
