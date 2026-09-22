#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
INSTALL_DIR=/opt/kuobox
REPO=kuobou/kuobox_test
REF=${KUOBOX_REF:-main}
MODE=${1:-install}
TMP_DIR=''
cleanup() { [[ -z "$TMP_DIR" ]] || rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT
trap 'printf "安裝／更新失敗（第 %s 行），請查看上方錯誤。\n" "$LINENO" >&2' ERR
die() { printf '%s\n' "$*" >&2; exit 1; }
fetch() { curl --fail --location --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 300 --proto '=https' --tlsv1.2 "$1" -o "$2"; }
[[ $EUID -eq 0 ]] || die '請使用 root 執行：sudo bash install.sh'
[[ "$MODE" == install || "$MODE" == update ]] || die '用法：bash install.sh [install|update]'
[[ "$REF" =~ ^[a-zA-Z0-9._/-]+$ && "$REF" != *..* ]] || die 'KUOBOX_REF 格式錯誤'
command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || die '目前支援 systemd Linux；不支援 Alpine/OpenRC、非 systemd 容器。'
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; SB_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; SB_ARCH=arm64 ;;
  *) die '目前自動安裝支援 x86_64 與 ARM64，未修改系統。' ;;
esac
need_tools=0
for tool in curl tar xz openssl sha256sum ping; do command -v "$tool" >/dev/null || need_tools=1; done
if [[ ! -s /etc/ssl/certs/ca-certificates.crt && ! -s /etc/pki/tls/certs/ca-bundle.crt && ! -s /var/lib/ca-certificates/ca-bundle.pem ]]; then need_tools=1; fi
if (( need_tools )); then
  if command -v apt-get >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl tar xz-utils openssl coreutils iputils-ping
  elif command -v dnf >/dev/null; then
    dnf install -y ca-certificates curl tar xz openssl coreutils iputils
  elif command -v yum >/dev/null; then
    yum install -y ca-certificates curl tar xz openssl coreutils iputils
  elif command -v zypper >/dev/null; then
    zypper --non-interactive install ca-certificates curl tar xz openssl coreutils iputils
  else die '請先安裝 curl/tar/xz/openssl/sha256sum/CA 憑證。'; fi
fi
TMP_DIR=$(mktemp -d /tmp/kuobox.XXXXXXXX)
NODE_BIN=$(command -v node || true)
if [[ -z "$NODE_BIN" ]] || ! "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  fetch https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt "$TMP_DIR/node-sha.txt"
  NODE_FILE=$(awk -v arch="$NODE_ARCH" '$2 ~ ("^node-v[0-9.]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$TMP_DIR/node-sha.txt")
  [[ "$NODE_FILE" =~ ^node-v[0-9.]+-linux-(x64|arm64)\.tar\.xz$ ]] || die '無法辨識官方 Node.js 發行檔案'
  NODE_VERSION=${NODE_FILE#node-}; NODE_VERSION=${NODE_VERSION%-linux-*}
  fetch "https://nodejs.org/dist/$NODE_VERSION/$NODE_FILE" "$TMP_DIR/$NODE_FILE"
  awk -v file="$NODE_FILE" '$2 == file' "$TMP_DIR/node-sha.txt" > "$TMP_DIR/node-check.txt"
  (cd "$TMP_DIR" && sha256sum -c node-check.txt)
  tar -xJf "$TMP_DIR/$NODE_FILE" -C "$TMP_DIR"
  "$TMP_DIR/${NODE_FILE%.tar.xz}/bin/node" --version || die '此 Linux 的 glibc 不符合 Node.js 需求，請升級作業系統。'
  mkdir -p /opt/kuobox-node
  cp -a "$TMP_DIR/${NODE_FILE%.tar.xz}/." /opt/kuobox-node/
  NODE_BIN=/opt/kuobox-node/bin/node
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
command -v npm >/dev/null || die 'Node.js 已存在但缺少 npm，請先安裝對應 npm。'
printf '從 GitHub 下載 kuoboX (%s)…\n' "$REF"
fetch "https://api.github.com/repos/$REPO/tarball/$REF" "$TMP_DIR/panel.tar.gz"
mkdir "$TMP_DIR/source"
tar -xzf "$TMP_DIR/panel.tar.gz" -C "$TMP_DIR/source" --strip-components=1
SOURCE="$TMP_DIR/source"
for file in server.js package.json package-lock.json public/index.html lib/config-store.js; do
  [[ -s "$SOURCE/$file" ]] || die "下載內容缺少 $file，停止更新"
done
"$NODE_BIN" --check "$SOURCE/server.js"
(cd "$SOURCE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

# Existing sing-box binary, configuration and service unit are never replaced.
if ! command -v sing-box >/dev/null; then
  [[ "$MODE" != update ]] || die '找不到現有 sing-box；更新模式不會變更核心。'
  fetch https://api.github.com/repos/SagerNet/sing-box/releases/latest "$TMP_DIR/sb-release.json"
  SB_VERSION=$("$NODE_BIN" -e 'const r=require(process.argv[1]); if(!/^v\d+\.\d+\.\d+$/.test(r.tag_name)) process.exit(1); console.log(r.tag_name.slice(1))' "$TMP_DIR/sb-release.json")
  SB_FILE="sing-box-${SB_VERSION}-linux-${SB_ARCH}.tar.gz"
  SB_DIGEST=$("$NODE_BIN" -e 'const r=require(process.argv[1]); const a=r.assets.find(a=>a.name===process.argv[2]); if(!a || !/^sha256:[a-f0-9]{64}$/.test(a.digest||"")) process.exit(1); console.log(a.digest.slice(7))' "$TMP_DIR/sb-release.json" "$SB_FILE")
  fetch "https://github.com/SagerNet/sing-box/releases/download/v$SB_VERSION/$SB_FILE" "$TMP_DIR/$SB_FILE"
  printf '%s  %s\n' "$SB_DIGEST" "$SB_FILE" > "$TMP_DIR/sb-check.txt"
  (cd "$TMP_DIR" && sha256sum -c sb-check.txt)
  tar -xzf "$TMP_DIR/$SB_FILE" -C "$TMP_DIR"
  install -m 755 "$TMP_DIR/sing-box-${SB_VERSION}-linux-${SB_ARCH}/sing-box" /usr/local/bin/sing-box
fi
SB_BIN=$(command -v sing-box)
if ! systemctl cat sing-box.service >/dev/null 2>&1; then
  [[ "$MODE" != update ]] || die '找不到 sing-box.service，請先完成核心安裝。'
  mkdir -p /etc/sing-box
  cat > /etc/systemd/system/sing-box.service <<EOF
[Unit]
Description=sing-box
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=$SB_BIN run -c /etc/sing-box/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable sing-box
fi
mkdir -p "$INSTALL_DIR"
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  [[ "$MODE" != update ]] || die '缺少 .env，停止更新。'
  PANEL_PORT=${PANEL_PORT:-3000}
  [[ "$PANEL_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$PANEL_PORT >= 1 && 10#$PANEL_PORT <= 65535 )) || die 'PANEL_PORT 必須為 1–65535'
  PANEL_PASSWORD=${PANEL_PASSWORD:-$(openssl rand -hex 18)}
  [[ ${#PANEL_PASSWORD} -ge 12 && "$PANEL_PASSWORD" != *$'\n'* && "$PANEL_PASSWORD" != *$'\r'* ]] || die '密碼至少 12 字元且不得含換行'
  printf 'PANEL_PORT=%s\n' "$PANEL_PORT" > "$INSTALL_DIR/.env"
  PANEL_PASSWORD="$PANEL_PASSWORD" "$NODE_BIN" -e 'process.stdout.write("PANEL_PASSWORD="+JSON.stringify(process.env.PANEL_PASSWORD)+"\n")' >> "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  NEW_PASSWORD=$PANEL_PASSWORD
fi
if grep -Eq '^PANEL_PASSWORD="?changeme123"?$' "$INSTALL_DIR/.env"; then
  die '既有設定仍使用預設密碼，請先透過 kuobox 修改為至少 12 字元的密碼。'
fi
mkdir -p "$INSTALL_DIR/cert"
if [[ ! -s "$INSTALL_DIR/cert/cert.pem" || ! -s "$INSTALL_DIR/cert/key.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$INSTALL_DIR/cert/key.pem" -out "$INSTALL_DIR/cert/cert.pem" -days 365 -subj '/CN=kuobox.local' -addext 'subjectAltName=DNS:kuobox.local,IP:127.0.0.1' >/dev/null 2>&1
fi
chmod 600 "$INSTALL_DIR/cert/key.pem"

# Back up application files only. Persistent data and sing-box are independent.
mkdir "$TMP_DIR/backup"
APP_FILES=(server.js package.json package-lock.json public lib node_modules install.sh kuobox.sh README.md)
WAS_ACTIVE=0
systemctl is-active --quiet kuobox && WAS_ACTIVE=1
for file in "${APP_FILES[@]}"; do
  [[ ! -e "$INSTALL_DIR/$file" ]] || cp -a "$INSTALL_DIR/$file" "$TMP_DIR/backup/"
done
[[ ! -f /etc/systemd/system/kuobox.service ]] || cp /etc/systemd/system/kuobox.service "$TMP_DIR/old-unit"
rollback() {
  trap - ERR
  printf '更新失敗，正在還原面板…\n' >&2
  for file in "${APP_FILES[@]}"; do
    rm -rf -- "$INSTALL_DIR/$file"
    [[ ! -e "$TMP_DIR/backup/$file" ]] || cp -a "$TMP_DIR/backup/$file" "$INSTALL_DIR/"
  done
  if [[ -f "$TMP_DIR/old-unit" ]]; then cp "$TMP_DIR/old-unit" /etc/systemd/system/kuobox.service; else rm -f /etc/systemd/system/kuobox.service; fi
  systemctl daemon-reload
  if (( WAS_ACTIVE )); then systemctl restart kuobox || printf '還原後啟動失敗，請查看 journalctl -u kuobox\n' >&2; else systemctl stop kuobox 2>/dev/null || true; fi
  exit 1
}
trap rollback ERR
for file in "${APP_FILES[@]}"; do
  rm -rf -- "$INSTALL_DIR/$file"
  [[ ! -e "$SOURCE/$file" ]] || cp -a "$SOURCE/$file" "$INSTALL_DIR/"
done
cat > /etc/systemd/system/kuobox.service <<EOF
[Unit]
Description=kuoboX relay management
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
Environment="PATH=$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="SINGBOX_BINARY=$SB_BIN"
ExecStart=$NODE_BIN $INSTALL_DIR/server.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kuobox
systemctl restart kuobox
sleep 2
systemctl is-active --quiet kuobox || rollback
install -m 755 "$INSTALL_DIR/kuobox.sh" /usr/bin/kuobox
trap 'printf "操作失敗（第 %s 行）\n" "$LINENO" >&2' ERR
printf '\nkuoboX 已就緒；sing-box 現有設定與服務狀態未變更。\n'
printf '面板端口：'; grep '^PANEL_PORT=' "$INSTALL_DIR/.env" | cut -d= -f2
printf '使用 https://你的VPS地址:面板端口 存取；初始憑證為自簽，亦可換成自己的憑證。\n'
[[ -z "${NEW_PASSWORD:-}" ]] || printf '初始密碼：%s\n' "$NEW_PASSWORD"
printf '管理指令：kuobox\n'
