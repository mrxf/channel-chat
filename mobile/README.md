# Agent 移动端（Flutter）

手机上的聊天客户端，和桌面端在同一个房间里互通（同一个服务器 + 同一个口令）。只做正常聊天，没有桌面端的伪装界面；也不能自己开服务器，只连接已有的服务器。

## 功能

| 功能 | 说明 |
|---|---|
| 登录 | 服务器地址实时检测在线；打开时自动监听局域网广播（Bonjour），点雷达图标再找一次，找不到时扫描本网段的 10686 端口；口令可一键生成并复制；可在本机记住口令（Android Keystore 加密） |
| 群聊 + 私聊 | 左上角抽屉：群聊和每个在线成员的私聊，各自的未读数。私聊只发给对方的连接 |
| 阅后即焚 | 与桌面端规则一致：保留最近 N 轮、已读后倒计时焚毁、未读不焚毁；焚毁时有模糊淡出动画 |
| 已读回执 | 自己的消息下方：单勾已发送，绿色双勾已读，群聊显示 n/总数 |
| 图片 / 视频 | ＋ → 相册 / 拍照 / 视频。发送前图片重新编码（最长边 2048，去 EXIF/GPS）；收到时是模糊的，点「查看」才解密，看完 N 秒焚毁。视频通过只监听 127.0.0.1 的内存服务器播放，不落盘 |
| 拍一拍 | ＋ → 拍一拍：服务器预制动作 + 自定义，可存为常用。收到时手机震动、界面抖一下 |
| 设置 | 会话设置（保留轮数、焚毁倒计时、媒体查看时长，全房间同步）、外观（跟随系统 / 浅色 / 深色）、通知（不显示内容）、禁止截屏（默认开启）、震动、口令指纹 |
| 其他 | 长按消息：复制 / 从我的屏幕清除；右上角：清屏（仅自己）/ 清空会话（双方）；返回键退到后台，连接保持；回到前台时自动重连 |

## 开发

```bash
cd mobile
flutter pub get
flutter run                    # 连接手机或模拟器（模拟器访问电脑上的服务器用 10.0.2.2:10686）
flutter test                   # 加密交叉验证 + 端到端互通测试（需要 Node 18+）
```

- `test/crypto_test.dart`：用桌面端 `src/crypto.js` 生成的向量（`tool/gen_vectors.mjs`）验证 scrypt / HKDF / XChaCha20-Poly1305 / 附件分块逐字节一致。
- `test/interop_test.dart`：启动真实的 `server/index.js`，用 `tool/peer.mjs`（桌面端协议对端）和手机端互发群聊、私聊、图片、回执、设置。

## 打包

```bash
cd mobile
flutter build apk --release --split-per-abi
# build/app/outputs/flutter-apk/app-arm64-v8a-release.apk   ← 绝大多数手机装这个
```

版本号跟随根目录 `package.json`：`npm run version:bump` / `npm run release` 会同步 `pubspec.yaml`（versionCode 自动 +1）和 `lib/core/version.dart`。推送 tag 后 GitHub Actions 会把 APK 一起放进 Release。

**签名**：没有 `android/key.properties` 时用 debug 签名，能直接安装，但每台机器的 debug 签名不同，换机器打的包升级时要先卸载。正式发布建议生成一个固定的签名：

```bash
keytool -genkey -v -keystore ~/agent.jks -keyalg RSA -keysize 2048 -validity 10000 -alias agent
```

然后写 `mobile/android/key.properties`（已在 .gitignore 里）：

```
storeFile=/Users/you/agent.jks
storePassword=...
keyAlias=agent
keyPassword=...
```

CI 里对应配置仓库 Secrets：`ANDROID_KEYSTORE_BASE64`（`base64 -i agent.jks`）、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。

## 目录

```
lib/
├── core/        加密（与桌面端兼容）、网络与局域网发现、附件预处理、本地偏好、系统能力
├── chat/        协议核心 ChatController（移植自桌面端 src/main.js）和数据模型
└── ui/          登录、聊天、抽屉、设置、面板、主题
```

## 已知限制

- App 在后台较久后，系统会断开连接；回到前台会自动重连，但离线期间别人发的消息收不到（服务器不暂存）。
- 视频发送没有缩略图（对方看到的是占位底色）。
- iOS 工程已配置好权限说明，但没有在 iPhone 上调试过。
