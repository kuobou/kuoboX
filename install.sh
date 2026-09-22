#!/usr/bin/env bash
# kuoboX 中轉面板 安裝／更新腳本
#   bash install.sh           安裝（已安裝時等同更新）
#   bash install.sh update    只更新面板程式
#   bash install.sh core      升級 sing-box 核心（先以新核心驗證現有設定）
# 可選環境變數：
#   PANEL_PORT=3000           首次安裝的面板端口
#   PANEL_PASSWORD=...        首次安裝的面板密碼（預設隨機）
#   GH_PROXY=https://...      GitHub 加速前綴（中國大陸機器可用）
#   NODE_MIRROR=https://...   Node.js 下載鏡像（預設 nodejs.org，失敗自動改用 npmmirror）
#   KUOBOX_REPO=owner/repo    KUOBOX_REF=main  面板來源
#   SINGBOX_VERSION=1.12.4    指定 sing-box 版本（預設最新穩定版）
set -Eeuo pipefail
umask 022
# CentOS/RHEL 的 sudo secure_path 不含 /usr/local/bin
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

INSTALL_DIR=/opt/kuobox
NODE_DIR=/opt/kuobox-node
CONF_FILE=$INSTALL_DIR/.install.conf
MODE=${1:-install}

# 更新時沿用首次安裝的來源設定
if [[ -r $CONF_FILE ]]; then
  while IFS='=' read -r key value; do
    case $key in KUOBOX_REPO|KUOBOX_REF|GH_PROXY|NODE_MIRROR) [[ -n ${!key:-} ]] || printf -v "$key" '%s' "$value" ;; esac
  done < "$CONF_FILE"
fi
REPO=${KUOBOX_REPO:-kuobou/kuobox_test}
REF=${KUOBOX_REF:-main}
GH_PROXY=${GH_PROXY:-}
NODE_MIRROR=${NODE_MIRROR:-}

if [[ -t 1 ]]; then C_G=$'\033[32m' C_Y=$'\033[33m' C_R=$'\033[31m' C_B=$'\033[1m' C_0=$'\033[0m'; else C_G='' C_Y='' C_R='' C_B='' C_0=''; fi
step() { printf '%s==>%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die() { printf '%s[✗]%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

TMP_DIR=''
cleanup() { [[ -z $TMP_DIR ]] || rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT
trap 'printf "%s[✗]%s 第 %s 行執行失敗，系統未完成變更，請查看上方訊息。\n" "$C_R" "$C_0" "$LINENO" >&2' ERR

fetch() { # fetch URL OUT
  curl --fail --location --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 \
    --proto '=https' --tlsv1.2 -A 'kuobox-installer' "$1" -o "$2"
}
gh_url() { if [[ -n $GH_PROXY ]]; then printf '%s/%s' "${GH_PROXY%/}" "$1"; else printf '%s' "$1"; fi; }

# ── 前置檢查 ──────────────────────────────────────────
[[ $EUID -eq 0 ]] || die '請使用 root 執行：sudo bash install.sh'
[[ $MODE == install || $MODE == update || $MODE == core ]] || die '用法：bash install.sh [install|update|core]'
[[ $REF =~ ^[A-Za-z0-9._/-]+$ && $REF != *..* ]] || die 'KUOBOX_REF 格式錯誤'
[[ $REPO =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die 'KUOBOX_REPO 格式錯誤'
[[ -z $GH_PROXY || $GH_PROXY =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?$ ]] || die 'GH_PROXY 必須是 https:// 網址'
[[ -z $NODE_MIRROR || $NODE_MIRROR =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?$ ]] || die 'NODE_MIRROR 必須是 https:// 網址'
command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || die '需要 systemd（不支援 Alpine/OpenRC、未啟用 systemd 的容器）'

case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH=x64; SB_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; SB_ARCH=arm64 ;;
  armv7l|armv7*) NODE_ARCH=armv7l; SB_ARCH=armv7 ;;
  *) die "不支援的 CPU 架構：$(uname -m)（支援 x86_64、ARM64、ARMv7）" ;;
esac

need=()
for tool in curl tar openssl sha256sum; do command -v "$tool" >/dev/null || need+=("$tool"); done
[[ -s /etc/ssl/certs/ca-certificates.crt || -s /etc/pki/tls/certs/ca-bundle.crt || -s /etc/ssl/ca-bundle.pem || -s /var/lib/ca-certificates/ca-bundle.pem ]] || need+=(ca-certificates)
if (( ${#need[@]} )); then
  step "安裝必要工具：${need[*]}"
  if command -v apt-get >/dev/null; then
    apt-get update -qq || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl tar openssl coreutils xz-utils >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q ca-certificates curl tar openssl coreutils xz >/dev/null
  elif command -v yum >/dev/null; then yum install -y -q ca-certificates curl tar openssl coreutils xz >/dev/null
  elif command -v zypper >/dev/null; then zypper --non-interactive -q install ca-certificates curl tar openssl coreutils xz >/dev/null
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm --needed ca-certificates curl tar openssl coreutils xz >/dev/null
  else die "請先手動安裝：${need[*]}"; fi
fi

free_mb=$(df -Pm /var/tmp 2>/dev/null | awk 'NR==2 {print $4}')
[[ -z $free_mb || $free_mb -ge 300 ]] || die "/var/tmp 可用空間不足 300 MB（目前 ${free_mb} MB）"
TMP_DIR=$(mktemp -d /var/tmp/kuobox.XXXXXXXX)

# ── Node.js（只保留執行檔，不需要 npm）─────────────────
node_ok() { [[ -x $1 ]] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>18||(a===18&&b>=15)?0:1)' >/dev/null 2>&1; }

glibc_old() {
  local v
  v=$(ldd --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+$' || true)
  [[ -n $v ]] && { [[ ${v%%.*} -lt 2 ]] || [[ ${v%%.*} -eq 2 && ${v#*.} -lt 28 ]]; }
}

install_node() { # 下載並校驗 Node.js，成功時設定 NODE_BIN
  local ext=tar.xz file='' base='' ver='' dir
  command -v xz >/dev/null || ext=tar.gz
  local -a sources=()
  if [[ $NODE_ARCH == x64 ]] && glibc_old; then
    warn '系統 glibc 版本低於 2.28，改用 Node.js 相容版本（glibc-217）'
    sources=("https://unofficial-builds.nodejs.org/download/release|glibc-217")
  else
    [[ -z $NODE_MIRROR ]] || sources+=("${NODE_MIRROR%/}|")
    sources+=("https://nodejs.org/dist|" "https://npmmirror.com/mirrors/node|")
  fi
  local src suffix
  for src in "${sources[@]}"; do
    base=${src%%|*}; suffix=${src#*|}
    if [[ -n $suffix ]]; then
      fetch "$base/index.json" "$TMP_DIR/node-index.json" 2>/dev/null || continue
      ver=$(grep -oE '"version":"v22\.[0-9]+\.[0-9]+"[^}]*linux-x64-glibc-217' "$TMP_DIR/node-index.json" | head -n1 | grep -oE 'v22\.[0-9]+\.[0-9]+' || true)
      [[ -n $ver ]] || continue
      fetch "$base/$ver/SHASUMS256.txt" "$TMP_DIR/node-sha.txt" 2>/dev/null || continue
      file="node-$ver-linux-x64-glibc-217.$ext"
    else
      fetch "$base/latest-v22.x/SHASUMS256.txt" "$TMP_DIR/node-sha.txt" 2>/dev/null || { warn "無法連線 $base，嘗試下一個來源"; continue; }
      file=$(awk -v arch="$NODE_ARCH" -v ext="$ext" '$2 ~ ("^node-v[0-9.]+-linux-" arch "\\." ext "$") {print $2; exit}' "$TMP_DIR/node-sha.txt")
      [[ -n $file ]] || continue
      ver=${file#node-}; ver=${ver%%-linux-*}
    fi
    step "下載 Node.js $ver（$base）"
    fetch "$base/$ver/$file" "$TMP_DIR/$file" || { warn '下載失敗，嘗試下一個來源'; continue; }
    awk -v f="$file" '$2 == f' "$TMP_DIR/node-sha.txt" > "$TMP_DIR/node-check.txt"
    [[ -s $TMP_DIR/node-check.txt ]] && (cd "$TMP_DIR" && sha256sum -c --quiet node-check.txt) || { warn 'Node.js 校驗失敗，嘗試下一個來源'; continue; }
    tar -xf "$TMP_DIR/$file" -C "$TMP_DIR"
    dir="$TMP_DIR/${file%."$ext"}"
    if ! "$dir/bin/node" --version >/dev/null 2>&1; then warn '此系統無法執行下載的 Node.js'; continue; fi
    rm -rf -- "$NODE_DIR.new"
    mkdir -p "$NODE_DIR.new/bin"
    install -m 755 "$dir/bin/node" "$NODE_DIR.new/bin/node"
    cp "$dir/LICENSE" "$NODE_DIR.new/" 2>/dev/null || true
    rm -rf -- "$NODE_DIR"
    mv "$NODE_DIR.new" "$NODE_DIR"
    NODE_BIN=$NODE_DIR/bin/node
    return 0
  done
  return 1
}

NODE_BIN=''
for candidate in "$NODE_DIR/bin/node" "$(command -v node || true)"; do
  if [[ -n $candidate ]] && node_ok "$candidate"; then NODE_BIN=$candidate; break; fi
done
if [[ -z $NODE_BIN && $MODE != core ]]; then
  install_node || die '無法安裝 Node.js：請確認機器可連線 nodejs.org 或 npmmirror.com，或以 NODE_MIRROR 指定鏡像；系統過舊時請升級作業系統'
fi
[[ -n $NODE_BIN ]] && step "使用 Node.js $("$NODE_BIN" --version)"

# ── sing-box 核心 ─────────────────────────────────────
SB_DIGEST=''
resolve_singbox() { # 設定 SB_VERSION 與（若可取得）SB_DIGEST
  SB_VERSION=${SINGBOX_VERSION:-}
  SB_VERSION=${SB_VERSION#v}
  if [[ -z $SB_VERSION ]] && fetch https://api.github.com/repos/SagerNet/sing-box/releases/latest "$TMP_DIR/sb.json" 2>/dev/null; then
    SB_VERSION=$(grep -oE '"tag_name":[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+"' "$TMP_DIR/sb.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
    if [[ -n $SB_VERSION && -n $NODE_BIN ]]; then
      SB_DIGEST=$("$NODE_BIN" -e 'const r=require(process.argv[1]);const a=(r.assets||[]).find(a=>a.name===process.argv[2]);if(a&&/^sha256:[a-f0-9]{64}$/.test(a.digest||""))console.log(a.digest.slice(7))' "$TMP_DIR/sb.json" "sing-box-$SB_VERSION-linux-$SB_ARCH.tar.gz" || true)
    fi
  fi
  if [[ -z $SB_VERSION ]]; then
    # GitHub API 限流時改用 releases/latest 轉址取得版本
    local url
    url=$(curl -fsSIL -o /dev/null -w '%{url_effective}' --connect-timeout 15 --max-time 60 "$(gh_url https://github.com/SagerNet/sing-box/releases/latest)" || true)
    SB_VERSION=$(grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+$' <<<"$url" | tr -d v || true)
  fi
  [[ $SB_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die '無法取得 sing-box 版本，可用 SINGBOX_VERSION=1.12.4 指定'
}

download_singbox() { # 下載並解壓到 $TMP_DIR/sb/sing-box
  local file="sing-box-$SB_VERSION-linux-$SB_ARCH.tar.gz"
  step "下載 sing-box $SB_VERSION"
  fetch "$(gh_url "https://github.com/SagerNet/sing-box/releases/download/v$SB_VERSION/$file")" "$TMP_DIR/$file" || die 'sing-box 下載失敗；中國大陸機器可設定 GH_PROXY'
  if [[ -n $SB_DIGEST ]]; then
    printf '%s  %s\n' "$SB_DIGEST" "$file" > "$TMP_DIR/sb-check.txt"
    (cd "$TMP_DIR" && sha256sum -c --quiet sb-check.txt) || die 'sing-box 校驗失敗，已停止'
  else
    warn '未取得官方 SHA-256（GitHub API 限流），僅依 HTTPS 驗證來源'
  fi
  mkdir -p "$TMP_DIR/sb"
  tar -xzf "$TMP_DIR/$file" -C "$TMP_DIR/sb" --strip-components=1
  "$TMP_DIR/sb/sing-box" version >/dev/null || die '下載的 sing-box 無法在此系統執行'
}

if [[ $MODE == core ]]; then
  SB_BIN=$(command -v sing-box || true)
  [[ -n $SB_BIN ]] || die '尚未安裝 sing-box'
  if { command -v dpkg >/dev/null && dpkg -S "$SB_BIN" >/dev/null 2>&1; } || { command -v rpm >/dev/null && rpm -qf "$SB_BIN" >/dev/null 2>&1; }; then
    die "sing-box 由套件管理器安裝（$SB_BIN），請使用 apt/dnf 升級"
  fi
  current=$("$SB_BIN" version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
  resolve_singbox
  if [[ $current == "$SB_VERSION" ]]; then step "sing-box 已是 $SB_VERSION，無需升級"; exit 0; fi
  download_singbox
  CFG=$(systemctl show -p ExecStart sing-box 2>/dev/null | grep -oE '(-c|--config) [^ ;]+' | head -n1 | awk '{print $2}' || true)
  CFG=${CFG:-/etc/sing-box/config.json}
  if [[ -s $CFG ]]; then
    "$TMP_DIR/sb/sing-box" check -c "$CFG" || die "新版 sing-box 無法通過現有設定驗證（$CFG），未升級。請先依版本說明調整設定"
  fi
  cp -p "$SB_BIN" "$TMP_DIR/sing-box.old"
  install -m 755 "$TMP_DIR/sb/sing-box" "$SB_BIN"
  if systemctl is-active --quiet sing-box; then
    systemctl restart sing-box; sleep 2
    if ! systemctl is-active --quiet sing-box; then
      install -m 755 "$TMP_DIR/sing-box.old" "$SB_BIN"; systemctl restart sing-box || true
      die '新核心啟動失敗，已還原舊版本'
    fi
  fi
  systemctl try-restart kuobox >/dev/null 2>&1 || true
  step "sing-box 已由 ${current:-未知} 升級至 $SB_VERSION"
  exit 0
fi

# ── 下載面板程式 ──────────────────────────────────────
step "下載 kuoboX（$REPO@$REF）"
SOURCE=$TMP_DIR/source
mkdir -p "$SOURCE"
downloaded=0
for url in "$(gh_url "https://github.com/$REPO/archive/$REF.tar.gz")" "https://codeload.github.com/$REPO/tar.gz/$REF" "https://api.github.com/repos/$REPO/tarball/$REF"; do
  if fetch "$url" "$TMP_DIR/panel.tar.gz" 2>/dev/null && tar -xzf "$TMP_DIR/panel.tar.gz" -C "$SOURCE" --strip-components=1 2>/dev/null; then downloaded=1; break; fi
  rm -rf -- "${SOURCE:?}"/* 2>/dev/null || true
done
(( downloaded )) || die '無法從 GitHub 下載面板；中國大陸機器請設定 GH_PROXY，例如：GH_PROXY=https://你的加速域名 bash install.sh'
for file in server.js package.json public/index.html public/app.js public/app.css lib/relay.js lib/config-store.js; do
  [[ -s $SOURCE/$file ]] || die "下載內容缺少 $file，已停止"
done
"$NODE_BIN" --check "$SOURCE/server.js"
"$NODE_BIN" -e 'for (const m of ["relay","links","saved-nodes","config-store","firewall","env-file"]) require(process.argv[1] + "/lib/" + m)' "$SOURCE"

# ── 首次安裝：sing-box 與服務 ─────────────────────────
if ! command -v sing-box >/dev/null; then
  [[ $MODE != update ]] || die '找不到 sing-box；更新模式不會安裝核心'
  resolve_singbox
  download_singbox
  install -m 755 "$TMP_DIR/sb/sing-box" /usr/local/bin/sing-box
fi
SB_BIN=$(command -v sing-box)
if ! systemctl cat sing-box.service >/dev/null 2>&1; then
  [[ $MODE != update ]] || die '找不到 sing-box.service'
  mkdir -p /etc/sing-box
  cat > /etc/systemd/system/sing-box.service <<EOF
[Unit]
Description=sing-box service
After=network-online.target nss-lookup.target
Wants=network-online.target
ConditionPathExists=/etc/sing-box/config.json

[Service]
ExecStart=$SB_BIN run -c /etc/sing-box/config.json -D /var/lib/sing-box
ExecReload=/bin/kill -HUP \$MAINPID
StateDirectory=sing-box
Restart=on-failure
RestartSec=3
LimitNOFILE=infinity

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable sing-box >/dev/null 2>&1
fi
SB_CONFIG=$(systemctl show -p ExecStart sing-box 2>/dev/null | grep -oE '(-c|--config) [^ ;]+' | head -n1 | awk '{print $2}' || true)
SB_CONFIG=${SB_CONFIG:-/etc/sing-box/config.json}

# ── 面板設定 ──────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR"
NEW_PASSWORD=''
if [[ ! -f $INSTALL_DIR/.env ]]; then
  [[ $MODE != update ]] || die '缺少 .env，請改用 install 模式'
  PANEL_PORT=${PANEL_PORT:-3000}
  [[ $PANEL_PORT =~ ^[0-9]{1,5}$ ]] && (( 10#$PANEL_PORT >= 1 && 10#$PANEL_PORT <= 65535 )) || die 'PANEL_PORT 必須為 1–65535'
  PANEL_PASSWORD=${PANEL_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)}
  [[ -n $PANEL_PASSWORD && $PANEL_PASSWORD != *$'\n'* && $PANEL_PASSWORD != *$'\r'* ]] || die '密碼不得為空或含換行'
  umask 077
  printf 'PANEL_PORT=%s\nSINGBOX_CONFIG=%s\n' "$((10#$PANEL_PORT))" "$SB_CONFIG" > "$INSTALL_DIR/.env"
  PANEL_PASSWORD=$PANEL_PASSWORD "$NODE_BIN" -e 'process.stdout.write("PANEL_PASSWORD="+JSON.stringify(process.env.PANEL_PASSWORD)+"\n")' >> "$INSTALL_DIR/.env"
  umask 022
  NEW_PASSWORD=$PANEL_PASSWORD
fi
chmod 600 "$INSTALL_DIR/.env"
PANEL_PORT=$(grep -E '^PANEL_PORT=' "$INSTALL_DIR/.env" | tail -n1 | cut -d= -f2)
PANEL_PORT=${PANEL_PORT:-3000}

mkdir -p "$INSTALL_DIR/cert"
chmod 700 "$INSTALL_DIR/cert"
if [[ ! -s $INSTALL_DIR/cert/cert.pem || ! -s $INSTALL_DIR/cert/key.pem ]]; then
  step '產生面板自簽憑證'
  cert_args=(req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$INSTALL_DIR/cert/key.pem" -out "$INSTALL_DIR/cert/cert.pem" -days 3650 -subj /CN=kuobox)
  openssl "${cert_args[@]}" -addext 'subjectAltName=DNS:kuobox' >/dev/null 2>&1 || openssl "${cert_args[@]}" >/dev/null 2>&1 \
    || openssl req -x509 -newkey rsa:2048 -nodes -keyout "$INSTALL_DIR/cert/key.pem" -out "$INSTALL_DIR/cert/cert.pem" -days 3650 -subj /CN=kuobox >/dev/null 2>&1
fi
chmod 600 "$INSTALL_DIR/cert/key.pem"
printf 'KUOBOX_REPO=%s\nKUOBOX_REF=%s\nGH_PROXY=%s\nNODE_MIRROR=%s\n' "$REPO" "$REF" "$GH_PROXY" "$NODE_MIRROR" > "$CONF_FILE"

# ── 替換面板程式（失敗自動還原）─────────────────────
APP_FILES=(server.js package.json public lib install.sh kuobox.sh README.md node_modules package-lock.json)
mkdir "$TMP_DIR/backup"
WAS_ACTIVE=0
systemctl is-active --quiet kuobox && WAS_ACTIVE=1
for file in "${APP_FILES[@]}"; do [[ ! -e $INSTALL_DIR/$file ]] || cp -a "$INSTALL_DIR/$file" "$TMP_DIR/backup/"; done
[[ ! -f /etc/systemd/system/kuobox.service ]] || cp /etc/systemd/system/kuobox.service "$TMP_DIR/old-unit"
rollback() {
  trap - ERR
  warn '安裝失敗，正在還原面板…'
  for file in "${APP_FILES[@]}"; do
    rm -rf -- "${INSTALL_DIR:?}/$file"
    [[ ! -e $TMP_DIR/backup/$file ]] || cp -a "$TMP_DIR/backup/$file" "$INSTALL_DIR/"
  done
  if [[ -f $TMP_DIR/old-unit ]]; then cp "$TMP_DIR/old-unit" /etc/systemd/system/kuobox.service; else rm -f /etc/systemd/system/kuobox.service; fi
  systemctl daemon-reload
  if (( WAS_ACTIVE )); then systemctl restart kuobox || warn '還原後啟動失敗，請查看 journalctl -u kuobox'; else systemctl stop kuobox 2>/dev/null || true; fi
  journalctl -u kuobox -n 15 --no-pager 2>/dev/null >&2 || true
  exit 1
}
trap rollback ERR
for file in "${APP_FILES[@]}"; do
  rm -rf -- "${INSTALL_DIR:?}/$file"
  [[ ! -e $SOURCE/$file ]] || cp -a "$SOURCE/$file" "$INSTALL_DIR/"
done
cat > /etc/systemd/system/kuobox.service <<EOF
[Unit]
Description=kuoboX relay panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
Environment="PATH=$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="SINGBOX_BINARY=$SB_BIN"
Environment="NODE_ENV=production"
ExecStart=$NODE_BIN --max-old-space-size=96 $INSTALL_DIR/server.js
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
systemctl enable kuobox >/dev/null 2>&1
systemctl restart kuobox
for _ in 1 2 3 4 5 6; do sleep 1; systemctl is-active --quiet kuobox && break; done
systemctl is-active --quiet kuobox || rollback
install -m 755 "$INSTALL_DIR/kuobox.sh" /usr/local/bin/kuobox
ln -sf /usr/local/bin/kuobox /usr/bin/kuobox 2>/dev/null || true
trap - ERR

# ── 放行面板端口（僅在主機防火牆啟用時）─────────────
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow "$PANEL_PORT/tcp" >/dev/null && step "已在 ufw 放行面板端口 $PANEL_PORT/tcp"
elif command -v firewall-cmd >/dev/null && [[ $(firewall-cmd --state 2>/dev/null) == running ]]; then
  firewall-cmd --permanent --add-port="$PANEL_PORT/tcp" >/dev/null && firewall-cmd --reload >/dev/null && step "已在 firewalld 放行面板端口 $PANEL_PORT/tcp"
fi

IP=$(curl -4 -fsS --connect-timeout 3 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
printf '\n%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$C_G" "$C_0"
printf '  %skuoboX 已就緒%s\n\n' "$C_B" "$C_0"
printf '  面板網址  https://%s:%s\n' "${IP:-你的VPS地址}" "$PANEL_PORT"
[[ -z $NEW_PASSWORD ]] || printf '  初始密碼  %s%s%s\n' "$C_B" "$NEW_PASSWORD" "$C_0"
printf '  管理指令  kuobox\n\n'
printf '  面板使用自簽憑證，瀏覽器提示「不安全」時選擇繼續前往即可。\n'
printf '  若 VPS 供應商有安全組，請開放 TCP %s 與之後建立的中轉端口。\n' "$PANEL_PORT"
printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$C_G" "$C_0"
