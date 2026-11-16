#!/usr/bin/env bash
# 一键配置 Android 正式签名：生成（或复用）签名文件 → 写入本地 android/key.properties → 可选写入 GitHub 仓库 Secrets。
#   bash mobile/tool/setup-signing.sh [签名文件路径，默认 ~/.android/agent-release.jks]
#
# 为什么需要：安卓只允许「同一个签名」的 App 覆盖升级。不配置时每台机器 / 每次 CI 用的 debug 签名都不同，升级要先卸载。
# 签名文件和密码务必备份好：丢了以后发出的新版本，已安装的手机就不能直接升级了。
set -euo pipefail

KS="${1:-$HOME/.android/agent-release.jks}"
ALIAS="agent"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROPS="$HERE/../android/key.properties"

JBR="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin"
command -v keytool >/dev/null || [[ ! -x "$JBR/keytool" ]] || export PATH="$JBR:$PATH"
command -v keytool >/dev/null || { echo "找不到 keytool，请先安装 JDK（Android Studio 自带：/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin）"; exit 1; }

if [[ -f "$KS" ]]; then
  echo "已有签名文件：$KS"
  read -r -s -p "输入它的密码：" PW; echo
  keytool -list -keystore "$KS" -storepass "$PW" -alias "$ALIAS" >/dev/null || { echo "密码不对，或签名文件里没有别名 $ALIAS"; exit 1; }
else
  mkdir -p "$(dirname "$KS")"
  read -r -s -p "给签名设置一个密码（至少 6 位）：" PW; echo
  read -r -s -p "再输入一次：" PW2; echo
  [[ "$PW" == "$PW2" ]] || { echo "两次输入不一致"; exit 1; }
  [[ ${#PW} -ge 6 ]] || { echo "密码至少 6 位"; exit 1; }
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PW" -keypass "$PW" -dname "CN=Agent, O=Agent" >/dev/null
  chmod 600 "$KS"
  echo "✓ 已生成签名文件：$KS"
fi

# 本地打包用（key.properties 已在 .gitignore 里，不会被提交）
cat > "$PROPS" <<EOF
storeFile=$KS
storePassword=$PW
keyAlias=$ALIAS
keyPassword=$PW
EOF
chmod 600 "$PROPS"
echo "✓ 已写入 mobile/android/key.properties，本地 flutter build apk 会使用正式签名"

# GitHub Actions 用
B64="$(base64 < "$KS" | tr -d '\n')"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  read -r -p "同时写入当前仓库的 GitHub Secrets？[Y/n] " yn
  if [[ ! "$yn" =~ ^[Nn] ]]; then
    printf '%s' "$B64"   | gh secret set ANDROID_KEYSTORE_BASE64
    printf '%s' "$PW"    | gh secret set ANDROID_KEYSTORE_PASSWORD
    printf '%s' "$ALIAS" | gh secret set ANDROID_KEY_ALIAS
    printf '%s' "$PW"    | gh secret set ANDROID_KEY_PASSWORD
    echo "✓ 已写入 GitHub Secrets，之后 Actions 打的包都是同一个签名"
  fi
else
  cat <<EOF

没有检测到已登录的 gh 命令行（brew install gh && gh auth login 后重新运行即可自动配置）。
也可以手动到 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret 添加：
  ANDROID_KEYSTORE_BASE64   执行这条命令复制：base64 < "$KS" | tr -d '\n' | pbcopy
  ANDROID_KEYSTORE_PASSWORD 你刚才输入的密码
  ANDROID_KEY_ALIAS         $ALIAS
  ANDROID_KEY_PASSWORD      你刚才输入的密码
EOF
fi

echo
echo "⚠ 请备份 $KS 和密码（比如存进密码管理器）。丢失后，已安装的手机无法直接升级到新签名的版本。"
