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
| 后台保持在线 | 进入会话后启动 Android 前台服务（通知栏常驻「会话进行中」），切到后台、锁屏后连接不断，照常收消息和通知；退出会话或从最近任务划掉 App 时停止。设置里可关闭；第一次进入会话时会引导允许「不受电池优化限制」 |
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

### 用 GitHub Actions（推荐）

`.github/workflows/android.yml`：

| 怎么触发 | 结果 |
|---|---|
| Actions 页面 → **Android** → **Run workflow**，或 `gh workflow run android.yml` | 跑测试 → 打包 → 更新「Android 测试版」预发布 |
| `mobile/` 有改动推送到 main | 同上，自动进行 |
| PR 改了 `mobile/` | 只跑检查和测试 |
| `npm run release` 推送 v* tag | 正式 Release 里附带 APK |

打完后手机浏览器打开 **`https://github.com/mrxf/channel-chat/releases/tag/android-nightly`**，直接下载 `Agent_<版本>-dev.<序号>_Android_arm64.apk` 安装。测试版每次覆盖，只保留最新一份，桌面端的自动更新不会把它当成新版本。每次运行的 Summary 里也有文件大小和签名信息，Artifacts 里有 zip 包。

### 签名（第一次用之前做一次）

安卓只允许同一个签名的 App 覆盖升级。不配置时用临时 debug 签名，每次都不同，升级要先卸载。一键配置：

```bash
bash mobile/tool/setup-signing.sh
```

它会生成 `~/.android/agent-release.jks`，写好本地的 `mobile/android/key.properties`（已在 .gitignore 里），并在 `gh` 已登录时自动写入仓库 Secrets（`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`）；没装 `gh` 会打印手动添加的步骤。**签名文件和密码一定要备份**，丢了以后已安装的手机就不能直接升级了。

### 本地打包

```bash
cd mobile
flutter build apk --release --split-per-abi
# build/app/outputs/flutter-apk/app-arm64-v8a-release.apk   ← 绝大多数手机装这个
```

版本号跟随根目录 `package.json`：`npm run version:bump` / `npm run release` 会同步 `pubspec.yaml` 和 `lib/core/version.dart`。安卓内部版本号（versionCode）由版本号推出（1.2.3 → 10203），本地和 CI 打的包一致，不会出现「降级无法安装」。

## 目录

```
lib/
├── core/        加密（与桌面端兼容）、网络与局域网发现、附件预处理、本地偏好、系统能力
├── chat/        协议核心 ChatController（移植自桌面端 src/main.js）和数据模型
└── ui/          登录、聊天、抽屉、设置、面板、主题
```

## 已知限制

- 小米、华为、OPPO、vivo 等系统有自己的后台管理，除了允许「不受电池优化限制」，还要在应用详情里打开「自启动 / 允许后台活动」，并在最近任务里锁定 Agent，否则长时间锁屏后仍可能被断开（设置 → 后台 → 系统后台管理）。
- 断线期间别人发的消息收不到（服务器不暂存）；回到前台会立即重连。
- iOS 不允许 App 在后台保持连接，切到后台后会断开，回到前台自动重连。
- 视频发送没有缩略图（对方看到的是占位底色）。
- iOS 工程已配置好权限说明，但没有在 iPhone 上调试过。
